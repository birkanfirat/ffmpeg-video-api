/* server.js
 * Endpoints:
 *  POST /render10min/start   (multipart: bg1..bg6 OR image, optional cta, + plan JSON string)
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
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 30 * 1024 * 1024), // 30MB default per file
    files: 12,
  },
});

// In-memory job store (Railway restart -> reset)
const jobs = new Map();

// cleanup old tmp folders (best-effort)
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 2 * 60 * 60 * 1000); // 2h
setInterval(async () => {
  try {
    const now = Date.now();
    for (const [jobId, j] of jobs.entries()) {
      if (!j?.createdAt || now - j.createdAt < JOB_TTL_MS) continue;
      try {
        if (j.dir) await fsp.rm(j.dir, { recursive: true, force: true });
      } catch (_) {}
      jobs.delete(jobId);
    }
  } catch (_) {}
}, 10 * 60 * 1000).unref();

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
    const LIMIT = 64 * 1024; // keep last 64KB only

    p.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > LIMIT) out = out.slice(out.length - LIMIT);
    });

    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > LIMIT) err = err.slice(err.length - LIMIT);
    });

    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) return resolve({ out, err });
      const extra = signal ? ` (signal=${signal})` : "";
      reject(
        new Error(`${bin} ${args.join(" ")} failed (code=${code}${extra}):\n${err}`)
      );
    });
  });
}

async function ffprobeDurationSec(filePath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
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
    "-loglevel",
    "error",
    "-i",
    inPath,
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outWav,
  ]);
}

async function concatWavs(listFilePath, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c:a",
    "pcm_s16le",
    outWav,
  ]);
}

// Cut trailing silence (no need to remove leading)
async function trimTrailingSilence(inWav, outWav) {
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    inWav,
    "-af",
    "areverse,silenceremove=stop_periods=-1:stop_duration=0.6:stop_threshold=-45dB,areverse,asetpts=N/SR/TB",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outWav,
  ]);
}

async function wavToM4a(inWav, outM4a) {
  await runCmd("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    inWav,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outM4a,
  ]);
}

// ---- Google TTS client ----
let _gcpClient = null;

function getGcpClient() {
  if (_gcpClient) return _gcpClient;

  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
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

  try {
    const client = getGcpClient();
    const request = {
      input: { text: String(text || "") },
      voice: { languageCode: "tr-TR", name: voiceName },
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

// ---------- VIDEO RENDER ----------

function pickExtByMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".img";
}

// Resolve CTA image:
// 1) multipart field "cta"
// 2) local file assets/cta.png
// 3) env CTA_IMAGE_URL (download)
async function resolveCta(jobDir, files) {
  const ctaFile = (files || []).find(
    (f) => String(f.fieldname).toLowerCase() === "cta" && f.buffer
  );
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

// Accept bg1..bg6 OR image
function pickBgFiles(files) {
  const arr = Array.isArray(files) ? files : [];
  const bgs = arr
    .filter((f) => f?.buffer && /^bg[1-6]$/i.test(String(f.fieldname || "")))
    .sort((a, b) => {
      const ai = Number(String(a.fieldname).slice(2)) || 0;
      const bi = Number(String(b.fieldname).slice(2)) || 0;
      return ai - bi;
    });

  if (bgs.length) return bgs;

  const single =
    arr.find((f) => String(f.fieldname).toLowerCase() === "image" && f.buffer) ||
    arr.find((f) => String(f.fieldname).toLowerCase() === "bg1" && f.buffer);

  return single ? [single] : [];
}

// Create MP4 from bg list + audio + optional CTA.
// Fixes:
// - zoom jitter reduced (integer x/y, fps single source)
// - CTA at bottom (not center) + alpha safe

async function imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan = {}, ctaPath = null) {
  const W = Number(process.env.VIDEO_W || plan.videoW || 1280);
  const H = Number(process.env.VIDEO_H || plan.videoH || 720);
  const fps = Number(process.env.VIDEO_FPS || plan.videoFps || 30);

  const preset = process.env.VIDEO_PRESET || plan.videoPreset || "veryfast";
  const tune = process.env.VIDEO_TUNE || plan.videoTune || "stillimage";

  const vb = process.env.VIDEO_BITRATE || plan.videoBitrate || "1800k";
  const maxrate = process.env.VIDEO_MAXRATE || plan.videoMaxrate || "2500k";
  const minrate = process.env.VIDEO_MINRATE || plan.videoMinrate || vb;
  const bufsize = process.env.VIDEO_BUFSIZE || plan.videoBufsize || "5000k";

  const threads = Number(process.env.FFMPEG_THREADS || 2);

  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur || 60);

  // ✅ Zoompan param
  const zoomPeriodSec = Number(process.env.ZOOM_PERIOD_SEC || plan.zoomPeriodSec || 10);
  const baseZoom = Number(process.env.ZOOM_BASE || plan.zoomBase || 1.005);
  const amplZoom = Number(process.env.ZOOM_AMPL || plan.zoomAmpl || 0.004);
  const denom = Math.max(60, Math.round(fps * zoomPeriodSec)); // on / denom

  // ✅ Overscan (sampling daha stabil)
  const overscan = Number(process.env.ZOOM_OVERSCAN || plan.zoomOverscan || 1.12);
  const bigW = Math.round(W * overscan);
  const bigH = Math.round(H * overscan);

  const ctaEnabled = Boolean(ctaPath) && (plan.cta !== false);
  const ctaStartDur = Number(process.env.CTA_START_DURATION_SEC || plan.ctaStartDurationSec || 4);
  const ctaEndDur = Number(process.env.CTA_DURATION_SEC || plan.ctaDurationSec || 6);
  const ctaBottomMargin = Number(process.env.CTA_BOTTOM_MARGIN || plan.ctaBottomMargin || 24);

  const args = ["-y", "-loglevel", "warning"];

  // scaler kalitesi (shimmer azaltır)
  args.push("-sws_flags", "lanczos+accurate_rnd+full_chroma_int");

  args.push("-threads", String(threads), "-filter_threads", "1", "-filter_complex_threads", "1");

  const bgCount = Math.max(1, Math.min(6, bgPaths.length || 1));
  const segDur = total / bgCount;

  // ✅ still image input
  for (let i = 0; i < bgCount; i++) {
    args.push("-loop", "1", "-t", String(segDur + 0.25), "-i", bgPaths[i]);
  }

  if (ctaEnabled) {
    args.push("-loop", "1", "-t", String(total + 0.25), "-i", ctaPath);
  }

  args.push("-i", audioPath);

  const parts = [];

  for (let i = 0; i < bgCount; i++) {
    parts.push(
      `[${i}:v]` +
        // 1) önce overscan boyuta sabitle
        `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${bigW}:${bigH},` +
        `format=yuv420p,` +
        // 2) zoompan (t yok, on var) + integer x/y → jitter azalır
        `zoompan=` +
          `z='max(1.0,${baseZoom}+${amplZoom}*sin(2*PI*on/${denom}))':` +
          `x='trunc(iw/2-(iw/zoom/2))':` +
          `y='trunc(ih/2-(ih/zoom/2))':` +
          `d=1:s=${W}x${H}:fps=${fps},` +
        `setsar=1,setpts=PTS-STARTPTS[v${i}]`
    );
  }

  const concatIns = Array.from({ length: bgCount }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIns}concat=n=${bgCount}:v=1:a=0[vbg]`);

  let vOut = "[vbg]";

  if (ctaEnabled) {
    const ctaIndex = bgCount;
    const ctaMaxW = Math.min(900, Math.round(W * 0.7));

    parts.push(`[${ctaIndex}:v]scale=w='min(iw,${ctaMaxW})':h=-1:flags=lanczos,format=rgba[cta]`);

    const startFrom = 0;
    const startTo = Math.min(total, ctaStartDur);
    const endFrom = Math.max(0, total - ctaEndDur);
    const endTo = total;

    const enableExpr =
      `between(t,${startFrom.toFixed(3)},${startTo.toFixed(3)})+between(t,${endFrom.toFixed(3)},${endTo.toFixed(3)})`;

    // ✅ CTA kesin altta: main_w/main_h
    parts.push(`${vOut}format=rgba[base]`);
    parts.push(
      `[base][cta]overlay=` +
        `x=(main_w-overlay_w)/2:` +
        `y=main_h-overlay_h-${ctaBottomMargin}:` +
        `enable='${enableExpr}':format=auto,` +
        `format=yuv420p[vout]`
    );

    vOut = "[vout]";
  } else {
    parts.push(`${vOut}format=yuv420p[vout]`);
    vOut = "[vout]";
  }

  const filter = parts.join(";");

  const audioIdx = ctaEnabled ? bgCount + 1 : bgCount;
  const gop = Number(process.env.VIDEO_GOP || plan.videoGop || fps * 2);

  args.push(
    "-filter_complex", filter,
    "-map", vOut,
    "-map", `${audioIdx}:a`,

    "-c:v", "libx264",
    "-preset", preset,
    "-tune", tune,

    "-b:v", vb,
    "-minrate", minrate,
    "-maxrate", maxrate,
    "-bufsize", bufsize,

    "-x264-params", `threads=${threads}:lookahead-threads=1:sliced-threads=0:nal-hrd=cbr`,

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

async function processJob(jobId, jobDir, bgPaths, plan, ctaPath) {
  try {
    setStage(jobId, "prepare");

    if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) {
      throw new Error("Plan.segments boş veya yok");
    }

    const maxAyah = Number(process.env.MAX_AYAH || plan.maxAyah || 0);
    if (maxAyah > 0 && plan.segments.length > maxAyah) {
      plan.segments = plan.segments.slice(0, maxAyah);
    }

    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });

    const wavs = [];
    let idx = 0;

    const addTtsClip = async (text, name) => {
      const raw = path.join(
        clipsDir,
        `${String(idx++).padStart(3, "0")}_${name}_raw.wav`
      );
      const norm = path.join(
        clipsDir,
        `${String(idx++).padStart(3, "0")}_${name}.wav`
      );
      await ttsTrToWav(text, raw);
      await normalizeToWav(raw, norm);
      wavs.push(norm);
    };

    const addMp3UrlClip = async (url, name) => {
      const mp3 = path.join(
        clipsDir,
        `${String(idx++).padStart(3, "0")}_${name}.mp3`
      );
      const wav = path.join(
        clipsDir,
        `${String(idx++).padStart(3, "0")}_${name}.wav`
      );
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

    setStage(jobId, "concat");
    const listPath = path.join(jobDir, "list.txt");
    const listBody = wavs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFileSafe(listPath, Buffer.from(listBody, "utf8"));

    const concatWav = path.join(jobDir, "concat.wav");
    await concatWavs(listPath, concatWav);

    setStage(jobId, "trim_silence");
    const finalWav = path.join(jobDir, "final_nosilence.wav");
    await trimTrailingSilence(concatWav, finalWav);

    setStage(jobId, "encode_audio");
    const audioM4a = path.join(jobDir, "audio.m4a");
    await wavToM4a(finalWav, audioM4a);

    setStage(jobId, "render_mp4");
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudioToMp4(bgPaths, audioM4a, outMp4, plan, ctaPath);

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

    const bgFiles = pickBgFiles(files);
    if (!bgFiles.length) {
      return res.status(400).json({
        error: "Missing required files. Need bg1..bg6 (or image) + plan. (audio upload is NOT required)",
        got: files.map((f) => f.fieldname),
      });
    }

    if (!req.body?.plan) {
      return res.status(400).json({ error: "Missing plan field" });
    }

    let plan;
    try {
      plan = JSON.parse(req.body.plan);
    } catch (_) {
      return res.status(400).json({ error: "Plan JSON parse error" });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render10min_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const bgPaths = [];
    for (let i = 0; i < Math.min(6, bgFiles.length); i++) {
      const f = bgFiles[i];
      const ext = pickExtByMime(f.mimetype);
      const p = path.join(jobDir, `bg_${String(i + 1).padStart(2, "0")}${ext}`);
      await writeFileSafe(p, f.buffer);
      bgPaths.push(p);
    }

    const ctaPath = await resolveCta(jobDir, files);

    jobs.set(jobId, {
      status: "processing",
      stage: "queued",
      dir: jobDir,
      createdAt: Date.now(),
    });

    setImmediate(() => processJob(jobId, jobDir, bgPaths, plan, ctaPath));

    res.json({
      jobId,
      bgCount: bgPaths.length,
      cta: Boolean(ctaPath),
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// STATUS
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "job_not_found" });

  if (job.status === "error") {
    return res.json({ status: "error", error: job.error || "unknown", stage: job.stage });
  }
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
