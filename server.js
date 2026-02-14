/* server.js
 * Endpoints:
 *  POST /render10min/start   (multipart: image file + plan JSON string)
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
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: set OPENAI_API_KEY in Railway env vars
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Multer: keep image in memory then write to job folder
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// In-memory job store (Railway restart -> reset). For production, persist to Redis/S3.
const jobs = new Map();
/**
 * job: {
 *   status: "processing"|"done"|"error",
 *   stage: string,
 *   error?: string,
 *   dir: string,
 *   outputPath?: string,
 *   createdAt: number
 * }
 */

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
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

async function ttsToWav(text, wavPath) {
  // Less robotic: gpt-4o-mini-tts + voice marin + wav output
  // (Model/voice list documented by OpenAI.)
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts", // or snapshot: "gpt-4o-mini-tts-2025-12-15"
    voice: "marin",
    input: text,
    // "instructions" supported per API reference:
    instructions:
      "Türkçe doğal ve sıcak anlatım. Net diksiyon. Cümle sonlarında kısa duraksamalar. Robotik ton yok. Okuma hızı sakin.",
    response_format: "wav",
    speed: 0.98,
  });

  const buf = Buffer.from(await response.arrayBuffer());
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

async function padOrTrimTo600s(inWav, outWav) {
  // Pad with silence if short, trim if long, target exactly 600 seconds
  await runCmd("ffmpeg", [
    "-y",
    "-i", inWav,
    "-af", "apad",
    "-t", "600",
    "-ar", "48000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outWav,
  ]);
}

async function wavToM4a(inWav, outM4a) {
  await runCmd("ffmpeg", [
    "-y",
    "-i", inWav,
    "-c:a", "aac",
    "-b:a", "192k",
    outM4a,
  ]);
}

/*async function imagePlusAudioToMp4(imagePath, audioPath, outMp4) {
  await runCmd("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,
    "-c:v", "libx264",
    "-tune", "stillimage",
    "-r", "30",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outMp4,
  ]);
}*/
async function imagePlusAudioToMp4(imagePath, audioPath, outMp4) {
  await runCmd("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,

    // 4K gelirse bile 1080p/720p'e düşür (Railway'de şart)
    "-vf", "scale=1280:-2",           // istersen 1920:-2 yap

    "-c:v", "libx264",
    "-preset", "veryfast",            // ultrafast daha da hafif ama kalite düşer
    "-crf", "28",                     // 23-30 arası; yükseldikçe dosya küçülür
    "-tune", "stillimage",
    "-r", "30",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",

    "-shortest",
    outMp4,
  ]);
}

function setStage(jobId, stage) {
  const j = jobs.get(jobId);
  if (!j) return;
  j.stage = stage;
}

async function processJob(jobId, jobDir, imagePath, plan) {
  try {
    setStage(jobId, "prepare");

    if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) {
      throw new Error("Plan.segments boş veya yok");
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

    setStage(jobId, "tts_intro");
    if (plan.introText) await addTtsClip(plan.introText, "intro");

    setStage(jobId, "tts_announce");
    if (plan.surahAnnouncementText) await addTtsClip(plan.surahAnnouncementText, "announce");

    setStage(jobId, "bismillah");
    if (plan.useBismillahClip && plan.bismillahAudioUrl) {
      await addMp3UrlClip(plan.bismillahAudioUrl, "bismillah_ar");
    }

    // Each segment: Arabic recitation mp3 + Turkish meal TTS
    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      if (!s || !s.arabicAudioUrl || !s.trText) continue;

      setStage(jobId, `seg_${i + 1}_ar`);
      await addMp3UrlClip(s.arabicAudioUrl, `ayah${s.ayah}_ar`);

      setStage(jobId, `seg_${i + 1}_tr`);
      // Meal TTS
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

    // guarantee 10 minutes
    setStage(jobId, "pad_to_600");
    const finalWav = path.join(jobDir, "final_600.wav");
    await padOrTrimTo600s(concatWav, finalWav);

    // encode audio
    setStage(jobId, "encode_audio");
    const audioM4a = path.join(jobDir, "audio.m4a");
    await wavToM4a(finalWav, audioM4a);

    // make mp4
    setStage(jobId, "render_mp4");
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagePlusAudioToMp4(imagePath, audioM4a, outMp4);

    // sanity: duration
    setStage(jobId, "verify");
    const dur = await ffprobeDurationSec(outMp4);
    if (dur < 590) {
      // should not happen due to padding; if it does, fail loudly
      throw new Error(`Video duration too short: ${dur.toFixed(2)}s`);
    }

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
app.post("/render10min/start", upload.single("image"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing image file field: image" });
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

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render10min_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const imagePath = path.join(jobDir, "bg.png");
    await writeFileSafe(imagePath, req.file.buffer);

    jobs.set(jobId, {
      status: "processing",
      stage: "queued",
      dir: jobDir,
      createdAt: Date.now(),
    });

    // Fire-and-forget in same process
    setImmediate(() => processJob(jobId, jobDir, imagePath, plan));

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// STATUS
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "job_not_found" });

  if (job.status === "error") return res.json({ status: "error", error: job.error || "unknown", stage: job.stage });
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
