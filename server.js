const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");

const textToSpeech = require("@google-cloud/text-to-speech");

const app = express();
const PORT = process.env.PORT || 3000;

// Multer yapılandırması
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 30 * 1024 * 1024),
    files: 12,
  },
});

const jobs = new Map();

// Temizlik döngüsü
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 2 * 60 * 60 * 1000);
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
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    const LIMIT = 64 * 1024;
    p.stdout.on("data", (d) => { out += d.toString(); if (out.length > LIMIT) out = out.slice(out.length - LIMIT); });
    p.stderr.on("data", (d) => { err += d.toString(); if (err.length > LIMIT) err = err.slice(err.length - LIMIT); });
    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${bin} failed (code=${code}):\n${err}`));
    });
  });
}

async function ffprobeDurationSec(filePath) {
  const args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath];
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

async function normalizeToWav(inPath, outWav) {
  await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-i", inPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
}

async function concatWavs(listFilePath, outWav) {
  await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFilePath, "-c:a", "pcm_s16le", outWav]);
}

async function trimTrailingSilence(inWav, outWav) {
  await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-i", inWav, "-af", "areverse,silenceremove=stop_periods=-1:stop_duration=0.6:stop_threshold=-45dB,areverse,asetpts=N/SR/TB", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
}

async function wavToM4a(inWav, outM4a) {
  await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-i", inWav, "-c:a", "aac", "-b:a", "192k", outM4a]);
}

// ---- Google TTS Sadece ----
let _gcpClient = null;
function getGcpClient() {
  if (_gcpClient) return _gcpClient;
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const b64 = process.env.GCP_TTS_KEY_B64;
  let creds;

  if (rawJson) creds = JSON.parse(rawJson);
  else if (b64) creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

  if (creds) {
    if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    _gcpClient = new textToSpeech.TextToSpeechClient({
      credentials: { client_email: creds.client_email, private_key: creds.private_key },
      projectId: creds.project_id,
    });
    return _gcpClient;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    _gcpClient = new textToSpeech.TextToSpeechClient();
    return _gcpClient;
  }
  throw new Error("Google TTS credentials missing.");
}

async function ttsTrToWav(text, wavPath) {
  const voiceName = process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-D";
  const speakingRate = Number(process.env.GCP_TTS_RATE || "1.0");
  const client = getGcpClient();
  const [response] = await client.synthesizeSpeech({
    input: { text: String(text || "") },
    voice: { languageCode: "tr-TR", name: voiceName },
    audioConfig: { audioEncoding: "LINEAR16", speakingRate, pitch: 0 },
  });
  await writeFileSafe(wavPath, Buffer.from(response.audioContent));
}

// ---------- VIDEO RENDER (STABILIZE EDİLMİŞ) ----------

function pickExtByMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".img";
}

async function resolveCta(jobDir, files) {
  const ctaFile = (files || []).find(f => String(f.fieldname).toLowerCase() === "cta" && f.buffer);
  if (ctaFile) {
    const p = path.join(jobDir, "cta.png");
    await writeFileSafe(p, ctaFile.buffer);
    return p;
  }
  const local = path.join(process.cwd(), "assets", "cta.png");
  try { await fsp.access(local, fs.constants.R_OK); return local; } catch (_) {}
  const url = process.env.CTA_IMAGE_URL;
  if (url) {
    const p = path.join(jobDir, "cta_download.png");
    await downloadToFile(url, p);
    return p;
  }
  return null;
}

function pickBgFiles(files) {
  const arr = Array.isArray(files) ? files : [];
  const bgs = arr
    .filter((f) => f?.buffer && /^bg[1-6]$/i.test(String(f.fieldname || "")))
    .sort((a, b) => (Number(a.fieldname.slice(2)) || 0) - (Number(b.fieldname.slice(2)) || 0));
  if (bgs.length) return bgs;
  const single = arr.find((f) => ["image", "bg1"].includes(f.fieldname.toLowerCase()) && f.buffer);
  return single ? [single] : [];
}

async function imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan = {}, ctaPath = null) {
  const W = Number(process.env.VIDEO_W || plan.videoW || 1280);
  const H = Number(process.env.VIDEO_H || plan.videoH || 720);
  const fps = Number(process.env.VIDEO_FPS || plan.videoFps || 30);
  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur || 60);

  // Zoom Ayarları
  const zoomMin = 1.0;
  const zoomMax = 1.1; // %10 zoom yeterince belirgindir
  const zoomPeriodSec = 15; 
  const denom = Math.round(fps * zoomPeriodSec);

  // Titreme Önleme: Kaynağı başta büyük ölçekle (overscan)
  const overscan = 1.15;
  const bigW = Math.round(W * overscan);
  const bigH = Math.round(H * overscan);

  const bgCount = Math.max(1, bgPaths.length);
  const segDur = total / bgCount;

  const args = ["-y", "-loglevel", "warning", "-sws_flags", "lanczos+accurate_rnd"];
  
  // BG Inputs
  for (let i = 0; i < bgCount; i++) {
    args.push("-loop", "1", "-t", String(segDur + 0.5), "-i", bgPaths[i]);
  }
  if (ctaPath) args.push("-loop", "1", "-t", String(total + 0.5), "-i", ctaPath);
  args.push("-i", audioPath);

  const parts = [];
  for (let i = 0; i < bgCount; i++) {
    // ✅ STABİL ZOOM FORMÜLÜ (Piksel titremesini keser)
    const zExpr = `${zoomMin}+(${zoomMax}-${zoomMin})*(0.5-0.5*cos(2*PI*on/${denom}))`;
    const xExpr = `trunc((iw-iw/zoom)/2/2)*2`;
    const yExpr = `trunc((ih-ih/zoom)/2/2)*2`;

    parts.push(
      `[${i}:v]scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},` +
      `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps},` +
      `setsar=1,setpts=PTS-STARTPTS[v${i}]`
    );
  }

  const concatIns = Array.from({ length: bgCount }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIns}concat=n=${bgCount}:v=1:a=0[vbg]`);

  let vOut = "[vbg]";
  if (ctaPath) {
    const ctaIdx = bgCount;
    parts.push(`[${ctaIdx}:v]scale=700:-1:flags=lanczos,format=rgba[cta]`);
    const enableExpr = `between(t,0,4)+between(t,${total-6},${total})`;
    parts.push(`[vbg][cta]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-40:enable='${enableExpr}':format=auto[vout]`);
    vOut = "[vout]";
  }

  args.push("-filter_complex", parts.join(";"), "-map", vOut, "-map", `${ctaPath ? bgCount + 1 : bgCount}:a`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart", outMp4);

  await runCmd("ffmpeg", args);
}

// --- İşleme Mantığı (Orijinal yapı korundu) ---

function setStage(jobId, stage) {
  const j = jobs.get(jobId);
  if (j) j.stage = stage;
}

async function processJob(jobId, jobDir, bgPaths, plan, ctaPath) {
  try {
    setStage(jobId, "prepare");
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

    if (plan.introText) { setStage(jobId, "tts_intro"); await addTtsClip(plan.introText, "intro"); }
    if (plan.surahAnnouncementText) { setStage(jobId, "tts_announce"); await addTtsClip(plan.surahAnnouncementText, "announce"); }
    if (plan.useBismillahClip && plan.bismillahAudioUrl) { setStage(jobId, "bismillah"); await addMp3UrlClip(plan.bismillahAudioUrl, "bismillah"); }

    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      setStage(jobId, `seg_${i+1}_ar`);
      await addMp3UrlClip(s.arabicAudioUrl, `ayah${i}_ar`);
      setStage(jobId, `seg_${i+1}_tr`);
      await addTtsClip(s.trText, `ayah${i}_tr`);
    }

    if (plan.outroText) { setStage(jobId, "tts_outro"); await addTtsClip(plan.outroText, "outro"); }

    setStage(jobId, "concat");
    const listPath = path.join(jobDir, "list.txt");
    await fsp.writeFile(listPath, wavs.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const concatWav = path.join(jobDir, "concat.wav");
    await concatWavs(listPath, concatWav);

    setStage(jobId, "trim");
    const finalWav = path.join(jobDir, "final.wav");
    await trimTrailingSilence(concatWav, finalWav);

    const audioM4a = path.join(jobDir, "audio.m4a");
    await wavToM4a(finalWav, audioM4a);

    setStage(jobId, "render_mp4");
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudioToMp4(bgPaths, audioM4a, outMp4, plan, ctaPath);

    const j = jobs.get(jobId);
    j.status = "done";
    j.outputPath = outMp4;
    j.stage = "done";
  } catch (err) {
    const j = jobs.get(jobId);
    if (j) { j.status = "error"; j.error = err.message; j.stage = "error"; }
  }
}

// --- Endpoints ---

app.post("/render10min/start", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    const bgFiles = pickBgFiles(files);
    if (!bgFiles.length || !req.body.plan) return res.status(400).json({ error: "Missing files or plan" });

    const plan = JSON.parse(req.body.plan);
    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const bgPaths = [];
    for (let i = 0; i < bgFiles.length; i++) {
      const p = path.join(jobDir, `bg${i}${pickExtByMime(bgFiles[i].mimetype)}`);
      await fsp.writeFile(p, bgFiles[i].buffer);
      bgPaths.push(p);
    }
    const ctaPath = await resolveCta(jobDir, files);

    jobs.set(jobId, { status: "processing", stage: "queued", dir: jobDir, createdAt: Date.now() });
    setImmediate(() => processJob(jobId, jobDir, bgPaths, plan, ctaPath));

    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json({ status: job.status, stage: job.stage, error: job.error });
});

app.get("/render10min/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job?.status === "done") res.sendFile(job.outputPath);
  else res.status(404).json({ error: "not_ready" });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
