/* server.js
 * Endpoints:
 *  POST /render10min/start   (multipart: bg1..bgN (+ optional cta) + plan JSON string)
 *  GET  /render10min/status/:jobId   -> { status: "processing"|"done"|"error", stage?, error? }
 *  GET  /render10min/result/:jobId   -> mp4 file stream
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");

// ✅ Google Cloud TTS
const textToSpeech = require("@google-cloud/text-to-speech");

const app = express();
const PORT = process.env.PORT || 3000;

// Multer: keep images in memory then write to job folder
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

// In-memory job store (Railway restart -> reset). For production, persist to Redis/S3.
const jobs = new Map();

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${bin} ${args.join(" ")} failed (code=${code}):\n${err}`));
    });
  });
}

async function ffprobeDurationSec(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  const { out } = await runCmd("ffprobe", args);
  const v = Number(String(out).trim());
  return Number.isFinite(v) ? v : 0;
}

async function writeFileSafe(filePath, buffer) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const ab = await res.arrayBuffer();
  await writeFileSafe(filePath, Buffer.from(ab));
}

// ✅ Google TTS client (service account from base64 env)
function createGoogleTtsClient() {
  const b64 = process.env.GCP_TTS_KEY_B64;
  if (!b64) {
    throw new Error(
      "GCP_TTS_KEY_B64 is missing. Put your Google service-account JSON as base64 into env."
    );
  }
  const jsonStr = Buffer.from(b64, "base64").toString("utf8");
  let creds;
  try {
    creds = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error("GCP_TTS_KEY_B64 is not valid JSON base64");
  }
  return new textToSpeech.TextToSpeechClient({ credentials: creds });
}

const gcpTtsClient = (() => {
  try {
    return createGoogleTtsClient();
  } catch (e) {
    // server start’ta patlatmak yerine, /start içinde kontrol edeceğiz
    return null;
  }
})();

// ✅ Google TTS -> WAV (LINEAR16)
async function ttsToWav(text, wavPath) {
  const client = gcpTtsClient || createGoogleTtsClient();

  const voiceName = process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-E";
  const speakingRate = Number(process.env.GCP_TTS_SPEAKING_RATE || "0.92");
  const pitch = Number(process.env.GCP_TTS_PITCH || "0");

  // Google TTS’nin stabil çalışması için: çok uzun metinleri parça parça okumak iyi olur.
  // Senin textlerin (meal) genelde makul ama yine de garanti olsun:
  const safeText = String(text || "").trim();
  if (!safeText) throw new Error("ttsToWav: empty text");

  const request = {
    input: { text: safeText },
    voice: {
      languageCode: "tr-TR",
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: "LINEAR16", // ✅ WAV PCM
      speakingRate: Number.isFinite(speakingRate) ? speakingRate : 0.92,
      pitch: Number.isFinite(pitch) ? pitch : 0,
      // effectsProfileId: ["telephony-class-application"], // istemezsen kapalı kalsın
    },
  };

  const [response] = await client.synthesizeSpeech(request);
  if (!response?.audioContent) {
    throw new Error("Google TTS returned empty audioContent");
  }

  // audioContent is Buffer (or Uint8Array)
  const buf = Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent);

  await writeFileSafe(wavPath, buf);
}

// Normalize any audio to 48kHz mono WAV PCM (concat sorunlarını bitirir)
async function normalizeToWav(inPath, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-i", inPath,
    "-ar", "48000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outWav,
  ]);
}

async function concatWavs(listFilePath, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listFilePath,
    "-c:a", "pcm_s16le",
    outWav,
  ]);
}

// ✅ Sondaki sessizliği kes (video sonunda boşluk kalmasın)
async function trimTrailingSilence(inWav, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-i", inWav,
    "-af",
    "silenceremove=stop_periods=-1:stop_duration=0.6:stop_threshold=-45dB,asetpts=N/SR/TB",
    "-ar", "48000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outWav,
  ]);
}

async function wavToM4a(inWav, outM4a) {
  await runCmd("ffmpeg", ["-y", "-i", inWav, "-c:a", "aac", "-b:a", "192k", outM4a]);
}

/**
 * ✅ Ken Burns + Sparks + Optional CTA overlay (end)
 * - imagePaths: [bg_01.png, bg_02.png, ...]
 * - audioPath: audio.m4a
 */
async function imagesPlusAudioToMp4(imagePaths, audioPath, outMp4) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error("No images provided");
  }

  const W = 1920;
  const H = 1080;
  const fps = 30;

  // audio süresi
  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur || 60);

  const n = imagePaths.length;
  const per = total / n;

  const args = ["-y"];

  // Her görseli ayrı input yapıyoruz
  for (let i = 0; i < n; i++) {
    args.push("-loop", "1", "-t", String(per + 0.2), "-i", imagePaths[i]);
  }

  // audio input en sonda
  args.push("-i", audioPath);

  const framePer = Math.ceil(per * fps);

  const parts = [];

  // Ken Burns per image
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},` +
        `fps=${fps},` +
        `zoompan=` +
          `z='min(zoom+0.0007,1.08)':` +
          `x='iw/2-(iw/zoom/2)':` +
          `y='ih/2-(ih/zoom/2)':` +
          `d=${framePer}:s=${W}x${H},` +
        `setsar=1,format=yuv420p` +
      `[v${i}]`
    );
  }

  // concat
  const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatInputs}concat=n=${n}:v=1:a=0[bg]`);

  // sparks
  parts.push(
    `nullsrc=s=${W}x${H}:d=${total},` +
    `noise=alls=40:allf=t+u,` +
    `format=gray,` +
    `lut=y='if(gt(val,253),255,0)',` +
    `boxblur=2:1[mask]`
  );

  parts.push(`color=c=white:s=${W}x${H}:d=${total}[white]`);
  parts.push(`[white][mask]alphamerge,format=rgba,colorchannelmixer=aa=0.28[sparks]`);

  parts.push(`[bg][sparks]overlay=shortest=1:format=auto,format=yuv420p[vout]`);

  const filter = parts.join(";");

  const aIdx = n;

  args.push(
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", `${aIdx}:a`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "-shortest",
    outMp4
  );

  await runCmd("ffmpeg", args);
}

function setStage(jobId, stage) {
  const j = jobs.get(jobId);
  if (!j) return;
  j.stage = stage;
}

// Resolve CTA image:
// 1) multipart field "cta" (preferred)
// 2) local file assets/cta.png
// 3) env CTA_IMAGE_URL (download)
async function resolveCta(jobDir, files) {
  const ctaFile = (files || []).find((f) => String(f.fieldname).toLowerCase() === "cta" && f.buffer);
  if (ctaFile) {
    const p = path.join(jobDir, "cta.png");
    await writeFileSafe(p, ctaFile.buffer);
    return p;
  }

  const local = path.join(process.cwd(), "assets", "cta.png");
  try {
    await fsp.access(local, fs.constants.R_OK);
    return local;
  } catch (_) {}

  const url = process.env.CTA_IMAGE_URL;
  if (url) {
    const p = path.join(jobDir, "cta_download.png");
    await downloadToFile(url, p);
    return p;
  }

  return null;
}

async function processJob(jobId, jobDir, bgPaths, plan, ctaPath) {
  try {
    setStage(jobId, "prepare");

    if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) {
      throw new Error("Plan.segments boş veya yok");
    }

    if (!Array.isArray(bgPaths) || bgPaths.length === 0) {
      throw new Error("BG paths boş");
    }

    // Build clips
    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });

    const wavs = [];
    let idx = 0;

    // Helper: add TTS clip (and normalize)
    const addTtsClip = async (text, name) => {
      const raw = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}_raw.wav`);
      const norm = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.wav`);
      await ttsToWav(text, raw);
      await normalizeToWav(raw, norm);
      wavs.push(norm);
    };

    // Helper: add mp3 from url (download + normalize)
    const addMp3UrlClip = async (url, name) => {
      const mp3 = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.mp3`);
      const wav = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.wav`);
      await downloadToFile(url, mp3);
      await normalizeToWav(mp3, wav);
      wavs.push(wav);
    };

    // ✅ Intro + announce + bismillah + segments + outro
    setStage(jobId, "tts_intro");
    if (plan.introText) await addTtsClip(plan.introText, "intro");

    setStage(jobId, "tts_announce");
    if (plan.surahAnnouncementText) await addTtsClip(plan.surahAnnouncementText, "announce");

    setStage(jobId, "bismillah");
    if (plan.useBismillahClip && plan.bismillahAudioUrl) {
      await addMp3UrlClip(plan.bismillahAudioUrl, "bismillah_ar");
    }

    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      if (!s || !s.arabicAudioUrl || !s.trText) continue;

      setStage(jobId, `seg_${i + 1}_ar`);
      await addMp3UrlClip(s.arabicAudioUrl, `ayah${s.ayah}_ar`);

      setStage(jobId, `seg_${i + 1}_tr`);
      await addTtsClip(s.trText, `ayah${s.ayah}_tr`);
    }

    setStage(jobId, "tts_outro");
    if (plan.outroText) await addTtsClip(plan.outroText, "outro");

    if (wavs.length === 0) throw new Error("Hiç audio clip üretilmedi");

    // concat list file
    setStage(jobId, "concat");
    const listPath = path.join(jobDir, "list.txt");
    const listBody = wavs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFileSafe(listPath, Buffer.from(listBody, "utf8"));

    const concatWav = path.join(jobDir, "concat.wav");
    await concatWavs(listPath, concatWav);

    // trailing silence temizle
    setStage(jobId, "trim_silence");
    const finalWav = path.join(jobDir, "final_nosilence.wav");
    await trimTrailingSilence(concatWav, finalWav);

    // encode audio
    setStage(jobId, "encode_audio");
    const audioM4a = path.join(jobDir, "audio.m4a");
    await wavToM4a(finalWav, audioM4a);

    // make mp4
    setStage(jobId, "render_mp4");
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudioToMp4(bgPaths, audioM4a, outMp4, plan, ctaPath);

    // sanity: duration
    setStage(jobId, "verify");
    const dur2 = await ffprobeDurationSec(outMp4);
    if (dur2 < 30) throw new Error(`Video duration too short: ${dur2.toFixed(2)}s`);

    const j = jobs.get(jobId);
    j.status = "done";
    j.outputPath = outMp4;
    j.stage = "done";
  } catch (err) {
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.error = err?.message || String(err);
      j.stage = "error";
    }
  }
}

// Health
app.get("/health", (_, res) => res.json({ ok: true }));

// START
app.post("/render10min/start", upload.any(), async (req, res) => {
  try {
    // ✅ Google creds check early
    if (!process.env.GCP_TTS_KEY_B64) {
      return res.status(500).json({ error: "GCP_TTS_KEY_B64 is missing" });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ error: "Missing image files. Send bg1..bgN (or image)." });
    }

    if (!req.body?.plan) {
      return res.status(400).json({ error: "Missing plan field" });
    }

    let plan;
    try {
      plan = JSON.parse(req.body.plan);
    } catch (e) {
      return res.status(400).json({ error: "Plan JSON parse error" });
    }

    // Accept:
    // - bg1, bg2, ... bgN
    // - optional cta
    // - optional image
    const validBgs = files
      .filter((f) => f?.buffer && typeof f.fieldname === "string")
      .filter((f) => f.fieldname === "image" || /^bg\d+$/i.test(f.fieldname))
      .sort((a, b) => {
        if (a.fieldname === "image" && b.fieldname !== "image") return -1;
        if (b.fieldname === "image" && a.fieldname !== "image") return 1;
        const na = Number(String(a.fieldname).replace(/^\D+/g, "")) || 0;
        const nb = Number(String(b.fieldname).replace(/^\D+/g, "")) || 0;
        return na - nb;
      });

    if (!validBgs.length) {
      return res.status(400).json({ error: "No valid bg files. Use bg1..bgN or image." });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render10min_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    // Write BGs
    const bgPaths = [];
    for (let i = 0; i < validBgs.length; i++) {
      const p = path.join(jobDir, `bg_${String(i + 1).padStart(2, "0")}.png`);
      await writeFileSafe(p, validBgs[i].buffer);
      bgPaths.push(p);
    }

    // Resolve CTA
    const ctaPath = await resolveCta(jobDir, files);

    jobs.set(jobId, {
      status: "processing",
      stage: "queued",
      dir: jobDir,
      createdAt: Date.now(),
    });

    setImmediate(() => processJob(jobId, jobDir, bgPaths, plan, ctaPath));

    res.json({ jobId, bgCount: bgPaths.length, cta: Boolean(ctaPath) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// STATUS
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "job_not_found" });

  if (job.status === "error")
    return res.json({ status: "error", error: job.error || "unknown", stage: job.stage });
  if (job.status === "done") return res.json({ status: "done", stage: job.stage });

  return res.json({ status: "processing", stage: job.stage });
});

// RESULT
app.get("/render10min/result/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.status !== "done" || !job.outputPath) {
    return res.status(409).json({ error: "job_not_done", status: job.status, stage: job.stage });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="output_${req.params.jobId}.mp4"`);

  const stream = fs.createReadStream(job.outputPath);
  stream.on("error", (e) => res.status(500).end(e.message));
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Render10min server running on :${PORT}`);
});
