const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const unzipper = require("unzipper");

const app = express();
const upload = multer({ dest: "uploads/" });

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function safeRmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function run(cmd, maxBufferMb = 200) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * maxBufferMb }, (err, stdout, stderr) => {
      if (err) {
        return reject({
          err,
          stdout,
          stderr: (stderr || "").slice(-8000),
        });
      }
      resolve({ stdout, stderr });
    });
  });
}

function clampZoomSpeed(z) {
  let zoomSpeed = parseFloat(z);
  if (isNaN(zoomSpeed)) zoomSpeed = 0.0003;
  return Math.max(0.00005, Math.min(zoomSpeed, 0.002));
}

function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/**
 * ✅ ESKİ ENDPOINT (KORUNDU)
 * image + audio => zoompan video
 */
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

      let zoomSpeed = clampZoomSpeed(req.query.zoomSpeed);

      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=125:s=1280x720:fps=25[v]" ` +
        `-map "[v]" -map 1:a ` +
        `-c:v libx264 -preset veryfast -crf 30 ` +
        `-c:a aac -b:a 128k -ac 2 -ar 44100 ` +
        `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`;

      exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({
            error: "ffmpeg failed",
            code: err.code,
            signal: err.signal,
            stderr: (stderr || "").slice(-4000),
          });
        }

        res.download(output, () => {
          safeUnlink(image);
          safeUnlink(audio);
          safeUnlink(output);
        });
      });
    } catch (e) {
      return res.status(500).json({ error: "server error", message: String(e) });
    }
  }
);

/**
 * ✅ YENİ ENDPOINT
 * image + audiosZip(zip içinde sıralı mp3'ler) => 10dk video
 *
 * zip içi dosya adları: 0001_INTRO_TR.mp3, 0002_BISM_AR.mp3, 0003_AR_001.mp3 ...
 */
app.post(
  "/render10min",
  upload.fields([{ name: "image", maxCount: 1 }, { name: "audiosZip", maxCount: 1 }]),
  async (req, res) => {
    const workId = crypto.randomBytes(8).toString("hex");
    const workDir = path.join(os.tmpdir(), `render10min_${workId}`);
    const audioDir = path.join(workDir, "audios");
    const wavDir = path.join(workDir, "wav");
    const listFile = path.join(workDir, "list.txt");
    const mergedAudio = path.join(workDir, "merged.m4a");
    const output = path.join(workDir, "output.mp4");

    try {
      if (!req.files?.image?.[0] || !req.files?.audiosZip?.[0]) {
        return res.status(400).json({
          error: "Missing required files",
          got: Object.keys(req.files || {}),
        });
      }

      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(audioDir, { recursive: true });
      fs.mkdirSync(wavDir, { recursive: true });

      const imagePath = req.files.image[0].path;
      const zipPath = req.files.audiosZip[0].path;

      // zip extract
      await fs
        .createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: audioDir }))
        .promise();

      // find mp3
      const files = listFilesRecursive(audioDir)
        .filter((f) => f.toLowerCase().endsWith(".mp3"))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

      if (!files.length) {
        return res.status(400).json({ error: "zip içinde mp3 bulunamadı" });
      }

      // silence durations (optional query)
      const pauseAfterAr = Math.max(0, parseFloat(req.query.pauseAfterAr ?? "0.6"));
      const pauseAfterTr = Math.max(0, parseFloat(req.query.pauseAfterTr ?? "0.5"));

      // convert to wav + build concat list (+silence)
      const lines = [];
      let idx = 0;

      for (const mp3 of files) {
        idx++;
        const base = path.basename(mp3, ".mp3");
        const wav = path.join(wavDir, `${String(idx).padStart(4, "0")}_${base}.wav`);

        // mp3 -> wav (unified format)
        await run(
          `ffmpeg -y -i "${mp3}" -ac 2 -ar 44100 -c:a pcm_s16le "${wav}"`,
          200
        );
        lines.push(`file '${wav.replace(/'/g, "'\\''")}'`);

        // decide silence based on filename tag
        const upper = base.toUpperCase();
        const isAr = upper.includes("_AR_") || upper.includes("_BISM_") || upper.includes("_AR.");
        const isTr = upper.includes("_TR_") || upper.includes("_INTRO_") || upper.includes("_SURE_") || upper.includes("_OUTRO_");

        const dur = isAr ? pauseAfterAr : isTr ? pauseAfterTr : 0;
        if (dur > 0.01) {
          const silenceWav = path.join(wavDir, `${String(idx).padStart(4, "0")}_silence_${dur}.wav`);
          await run(
            `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${dur} -c:a pcm_s16le "${silenceWav}"`,
            50
          );
          lines.push(`file '${silenceWav.replace(/'/g, "'\\''")}'`);
        }
      }

      fs.writeFileSync(listFile, lines.join("\n"));

      // concat wav -> m4a
      await run(
        `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a aac -b:a 192k "${mergedAudio}"`,
        300
      );

      // video render (zoompan)
      let zoomSpeed = clampZoomSpeed(req.query.zoomSpeed);

      await run(
        `ffmpeg -y -loop 1 -i "${imagePath}" -i "${mergedAudio}" ` +
          `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=125:s=1280x720:fps=25[v]" ` +
          `-map "[v]" -map 1:a ` +
          `-c:v libx264 -preset veryfast -crf 30 ` +
          `-c:a aac -b:a 192k -ac 2 -ar 44100 ` +
          `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`,
        300
      );

      res.download(output, () => {
        safeUnlink(imagePath);
        safeUnlink(zipPath);
        safeRmDir(workDir);
      });
    } catch (e) {
      safeRmDir(workDir);
      return res.status(500).json({
        error: "render10min failed",
        message: String(e?.err || e),
        stderr: e?.stderr,
      });
    }
  }
);

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("server running on 3000"));
 
