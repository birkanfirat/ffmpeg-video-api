/* server.js
 * Endpoints:
 *  POST /render10min/start   (multipart: bg1 (+ optional cta) + plan JSON string)
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

const textToSpeech = require("@google-cloud/text-to-speech");
// (opsiyonel fallback) OpenAI kalsın istersen
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- OpenAI fallback (istersen) ----
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Multer: keep files in memory then write to job folder
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// In-memory job store (Railway restart -> reset)
const jobs = new Map();

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

// ---- safer cmd runner (prevents RAM blowups) ----
function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });

    let out = "";
    let err = "";
    const ERR_LIMIT = 64 * 1024; // keep last 64KB only

    p.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > ERR_LIMIT) out = out.slice(out.length - ERR_LIMIT);
    });

    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > ERR_LIMIT) err = err.slice(err.length - ERR_LIMIT);
    });

    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) return resolve({ out, err });
      const extra = signal ? ` (signal=${signal})` : "";
      reject(new Error(`${bin} ${args.join(" ")} failed (code=${code}${extra}):\n${err}`));
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

// Normalize any audio to 48kHz mono WAV PCM
async function normalizeToWav(inPath, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel", "error",
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
    "-loglevel", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", listFilePath,
    "-c:a", "pcm_s16le",
    outWav,
  ]);
}

// Cut trailing silence
async function trimTrailingSilence(inWav, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel", "error",
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
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", inWav,
    "-c:a", "aac",
    "-b:a", "192k",
    outM4a,
  ]);
}

// ---- Google TTS client ----
let _gcpClient = null;

function getGcpClient() {
  if (_gcpClient) return _gcpClient;

  // 1) standard JSON env
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // 2) your Railway variable: base64 of service account JSON
  const b64 = process.env.GCP_TTS_KEY_B64;

  if (rawJson) {
    const creds = JSON.parse(rawJson);
    if (creds.private_key && typeof creds.private_key === "string") {
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }
    _gcpClient = new textToSpeech.TextToSpeechClient({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      projectId: creds.project_id,
    });
    return _gcpClient;
  }

  if (b64) {
    const jsonStr = Buffer.from(b64, "base64").toString("utf8");
    const creds = JSON.parse(jsonStr);
    if (creds.private_key && typeof creds.private_key === "string") {
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }
    _gcpClient = new textToSpeech.TextToSpeechClient({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      projectId: creds.project_id,
    });
    return _gcpClient;
  }

  // 3) fallback: GOOGLE_APPLICATION_CREDENTIALS file path (ADC)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    _gcpClient = new textToSpeech.TextToSpeechClient();
    return _gcpClient;
  }

  throw new Error(
    "Google TTS credentials missing. Set GCP_TTS_KEY_B64 (base64 service account json) or GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
  );
}

async function ttsTrToWav(text, wavPath) {
  const voiceName = process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-D";
  const speakingRate = Number(process.env.GCP_TTS_RATE || "1.0");
  const pitch = Number(process.env.GCP_TTS_PITCH || "0");

  // Google first
  try {
    const client = getGcpClient();
    const request = {
      input: { text: String(text || "") },
      voice: {
        languageCode: "tr-TR",
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: "LINEAR16",
        speakingRate,
        pitch,
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    if (!response?.audioContent) throw new Error("Google TTS audioContent boş");
    await writeFileSafe(wavPath, Buffer.from(response.audioContent));
    return;
  } catch (e) {
    // fallback OpenAI (opsiyonel)
    if (!openai) throw e;

    const voice = process.env.OPENAI_TTS_VOICE || "marin";
    const instructions =
      process.env.OPENAI_TTS_INSTRUCTIONS ||
      "Türkçe doğal ve sıcak anlatım. Net diksiyon. Cümle sonlarında kısa duraksamalar.";

    const resp = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: String(text || ""),
      instructions,
      response_format: "wav",
      speed: 0.95,
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    await writeFileSafe(wavPath, buf);
  }
}

// ---- single image + subtle zoom in/out + optional CTA at end ----
async function imagePlusAudioToMp4Single(bgPath, audioPath, outMp4, plan = {}, ctaPath = null) {
  // Output settings (env ile kontrol edilebilir)
  const W = Number(process.env.VIDEO_W || plan.videoW || 1920);
  const H = Number(process.env.VIDEO_H || plan.videoH || 1080);
  const fps = Number(process.env.VIDEO_FPS || plan.videoFps || 30);

  // Boyut kontrolü (asıl kritik kısım)
  const preset = process.env.VIDEO_PRESET || plan.videoPreset || "veryfast"; // ❌ ultrafast kullanma
  const crf = Number(process.env.VIDEO_CRF || plan.videoCrf || 28);          // 26-30 arası iyi
  const maxrate = process.env.VIDEO_MAXRATE || plan.videoMaxrate || "2500k"; // 10 dk ~ 180-220MB
  const bufsize = process.env.VIDEO_BUFSIZE || plan.videoBufsize || "5000k";
  const tune = process.env.VIDEO_TUNE || plan.videoTune || "stillimage";

  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur || 60);

  // Zoom ayarları (titremeyi azaltmak için daha düşük amplitude + doğru fps zinciri)
  const zoomPeriodSec = Number(process.env.ZOOM_PERIOD_SEC || plan.zoomPeriodSec || 8);
  const baseZoom = Number(process.env.ZOOM_BASE || plan.zoomBase || 1.01);
  const amplZoom = Number(process.env.ZOOM_AMPL || plan.zoomAmpl || 0.01);

  // periyot frame cinsinden
  const denom = Math.max(60, Math.round(fps * zoomPeriodSec));

  const ctaEnabled = Boolean(ctaPath) && (plan.cta !== false);
  const ctaDur = Number(process.env.CTA_DURATION_SEC || plan.ctaDurationSec || 6);

  // ✅ KRİTİK: image inputlarını 30 fps diye “okut” (25/30 karışıklığı → titreme yapıyordu)
  const args = ["-y", "-loglevel", "error"];
  args.push("-framerate", String(fps), "-loop", "1", "-t", String(total + 0.25), "-i", bgPath);

  if (ctaEnabled) {
    args.push("-framerate", String(fps), "-loop", "1", "-t", String(total + 0.25), "-i", ctaPath);
  }

  args.push("-i", audioPath);

  // Background filter: scale/crop + smooth zoompan
  // Not: fps filtresini KALDIRDIK (input framerate’i zaten fps yaptık)
  const parts = [];
  parts.push(
    `[0:v]` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},` +
      `format=yuv420p,` +
      `zoompan=` +
        `z='max(1.0,${baseZoom}+${amplZoom}*sin(2*PI*on/${denom}))':` +
        `x='(iw-iw/zoom)/2':` +
        `y='(ih-ih/zoom)/2':` +
        `d=1:s=${W}x${H},` +
      `setsar=1[vbg]`
  );

  let vOut = "[vbg]";

  if (ctaEnabled) {
    const enableFrom = Math.max(0, total - ctaDur);
    const enableTo = total;

    parts.push(`[1:v]scale=${W}:-1,format=rgba[cta]`);
    parts.push(
      `${vOut}[cta]overlay=` +
        `x=(W-w)/2:` +
        `y=H-h-40:` +
        `enable='between(t,${enableFrom.toFixed(3)},${enableTo.toFixed(3)})':` +
        `format=auto[vout]`
    );
    vOut = "[vout]";
  } else {
    parts.push(`${vOut}format=yuv420p[vout]`);
    vOut = "[vout]";
  }

  const filter = parts.join(";");

  const audioIdx = ctaEnabled ? 2 : 1;

  // GOP (keyframe) stabilitesi
  const gop = Number(process.env.VIDEO_GOP || plan.videoGop || (fps * 2)); // 2 saniye

  args.push(
    "-filter_complex", filter,
    "-map", vOut,
    "-map", `${audioIdx}:a`,

    "-c:v", "libx264",
    "-preset", preset,
    "-tune", tune,
    "-crf", String(crf),

    // ✅ Boyut kontrolü (VBV cap)
    "-maxrate", maxrate,
    "-bufsize", bufsize,

    // ✅ Stabil timeline / keyframe
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",

    "-pix_fmt", "yuv420p",
    "-r", String(fps),

    "-c:a", "aac",
    "-b:a", "128k",

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
// 1) multipart field "cta"
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

function pickExtByMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".img";
}

async function processJob(jobId, jobDir, bgPath, plan, ctaPath) {
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

    const addTtsClip = async (text, name) => {
      const raw = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}_raw.wav`);
      const norm = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.wav`);
      await ttsTrToWav(text, raw);
      await normalizeToWav(raw, norm);
      wavs.push(norm);
    };

    const addMp3UrlClip = async (url, name) => {
      const mp3 = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.mp3`);
      const wav = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.wav`);
      await downloadToFile(url, mp3);
      await normalizeToWav(mp3, wav);
      wavs.push(wav);
    };

    // Intro + announce + bismillah + segments + outro
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

    // render mp4
    setStage(jobId, "render_mp4");
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagePlusAudioToMp4Single(bgPath, audioM4a, outMp4, plan, ctaPath);

    setStage(jobId, "verify");
    const dur = await ffprobeDurationSec(outMp4);
    if (dur < 10) throw new Error(`Video duration too short: ${dur.toFixed(2)}s`);

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
    const files = Array.isArray(req.files) ? req.files : [];

    // ✅ BG required (bg1 or image)
    const bgFile =
      files.find((f) => String(f.fieldname).toLowerCase() === "bg1" && f.buffer) ||
      files.find((f) => String(f.fieldname).toLowerCase() === "image" && f.buffer);

    if (!bgFile) {
      return res.status(400).json({
        error: "Missing required files. Need bg1 (or image) + plan. (audio upload is NOT required)",
        got: files.map((f) => f.fieldname),
      });
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

    // write BG with correct extension
    const ext = pickExtByMime(bgFile.mimetype);
    const bgPath = path.join(jobDir, `bg_01${ext}`);
    await writeFileSafe(bgPath, bgFile.buffer);

    // CTA optional
    const ctaPath = await resolveCta(jobDir, files);

    jobs.set(jobId, {
      status: "processing",
      stage: "queued",
      dir: jobDir,
      createdAt: Date.now(),
    });

    setImmediate(() => processJob(jobId, jobDir, bgPath, plan, ctaPath));

    res.json({ jobId, bg: path.basename(bgPath), cta: Boolean(ctaPath) });
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
