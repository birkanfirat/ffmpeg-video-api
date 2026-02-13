const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const app = express();
const upload = multer({ dest: "uploads/" });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadToFile(url, outPath) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Download failed ${resp.status}: ${txt.slice(0, 200)}`);
  }
  if (!resp.body) throw new Error("Download response has no body");
  const nodeStream = Readable.fromWeb(resp.body);
  await pipeline(nodeStream, fs.createWriteStream(outPath));
}

async function elevenTtsToFile(text, outPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

  if (!apiKey || !voiceId) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID env");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  let attempt = 0;
  while (true) {
    attempt++;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      return;
    }

    // 429 backoff
    if (resp.status === 429 && attempt <= 6) {
      const waitMs = Math.min(15000, 800 * Math.pow(2, attempt));
      await sleep(waitMs);
      continue;
    }

    const errTxt = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs failed ${resp.status}: ${errTxt.slice(0, 400)}`);
  }
}

// ✅ Eski endpoint aynen duruyor: image + audio -> video
app.post(
  "/render",
  upload.fields([{ name: "image" }, { name: "audio" }]),
  (req, res) => {
    try {
      if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
        return res.status(400).json({
          error: "Missing required files",
          got: Object.keys(req.files || {}),
        });
      }

      const image = req.files.image[0].path;
      const audio = req.files.audio[0].path;
      const output = "output.mp4";

      let zoomSpeed = parseFloat(req.query.zoomSpeed);
      if (isNaN(zoomSpeed)) zoomSpeed = 0.0003;
      zoomSpeed = Math.max(0.00005, Math.min(zoomSpeed, 0.002));

      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=1:s=1280x720:fps=25[v]" ` +
        `-map "[v]" -map 1:a ` +
        `-c:v libx264 -preset veryfast -crf 30 ` +
        `-c:a aac -b:a 128k -ac 2 -ar 44100 ` +
        `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`;

      exec(cmd, { maxBuffer: 1024 * 1024 * 40 }, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({
            error: "ffmpeg failed",
            code: err.code,
            signal: err.signal,
            stderr: (stderr || "").slice(-4000),
          });
        }

        res.download(output, () => {
          try { fs.unlinkSync(image); } catch {}
          try { fs.unlinkSync(audio); } catch {}
          try { fs.unlinkSync(output); } catch {}
        });
      });
    } catch (e) {
      return res.status(500).json({ error: "server error", message: String(e) });
    }
  }
);

// ✅ Yeni endpoint: image + plan -> 10dk video (AR mp3 download + TR TTS)  (axios yok)
app.post(
  "/render10min",
  upload.fields([{ name: "image", maxCount: 1 }]),
  async (req, res) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render10min-"));
    try {
      if (!req.files?.image?.[0]) return res.status(400).json({ error: "Missing image" });
      if (!req.body?.plan) return res.status(400).json({ error: "Missing plan field" });

      const plan = JSON.parse(req.body.plan);
      const imagePath = req.files.image[0].path;

      const jobs = [];
      let order = 1;
      const pad = (n) => String(n).padStart(4, "0");

      const addTTS = (tag, text) => jobs.push({ kind: "tts", order: order++, fileName: `${pad(order - 1)}_${tag}.mp3`, text });
      const addDL  = (tag, url)  => jobs.push({ kind: "download", order: order++, fileName: `${pad(order - 1)}_${tag}.mp3`, url });

      addTTS("TR_INTRO", plan.introText || "");
      if (plan.useBismillahClip && plan.bismillahAudioUrl) addDL("AR_BISM", plan.bismillahAudioUrl);
      addTTS("TR_SURE", plan.surahAnnouncementText || "");

      for (const s of plan.segments || []) {
        addDL(`AR_${String(s.ayah).padStart(3, "0")}`, s.arabicAudioUrl);
        addTTS(`TR_${String(s.ayah).padStart(3, "0")}`, s.trText || "");
      }
      addTTS("TR_OUTRO", plan.outroText || "");

      // ✅ SEQ üretim/indirme (429 riskini minimize eder)
      const audioFiles = [];
      for (const j of jobs) {
        const out = path.join(tmpDir, j.fileName);
        if (j.kind === "download") {
          await downloadToFile(j.url, out);
        } else {
          await elevenTtsToFile(j.text, out);
          await sleep(900);
        }
        audioFiles.push(out);
      }

      // ffmpeg concat list
      const listPath = path.join(tmpDir, "list.txt");
      fs.writeFileSync(
        listPath,
        audioFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
        "utf8"
      );

      const audioOut = path.join(tmpDir, "all.mp3");
      const concatCmd =
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" ` +
        `-c:a libmp3lame -b:a 128k "${audioOut}"`;

      await new Promise((resolve, reject) => {
        exec(concatCmd, { maxBuffer: 1024 * 1024 * 40 }, (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || "").slice(-4000)));
          else resolve();
        });
      });

      const output = path.join(tmpDir, "output.mp4");
      const zoomSpeed = 0.00025;

      const videoCmd =
        `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioOut}" ` +
        `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=1:s=1280x720:fps=25[v]" ` +
        `-map "[v]" -map 1:a ` +
        `-c:v libx264 -preset veryfast -crf 30 ` +
        `-c:a aac -b:a 128k -ac 2 -ar 44100 ` +
        `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`;

      await new Promise((resolve, reject) => {
        exec(videoCmd, { maxBuffer: 1024 * 1024 * 40 }, (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || "").slice(-4000)));
          else resolve();
        });
      });

      res.download(output, () => {
        try { fs.unlinkSync(imagePath); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      });
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: "server error", message: String(e?.message || e) });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server running on", PORT));
