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
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 30 * 1024 * 1024),
    files: 12,
  },
});

const jobs = new Map();

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

let _gcpClient = null;
function getGcpClient() {
  if (_gcpClient) return _gcpClient;
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const creds = JSON.parse(rawJson);
    if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    _gcpClient = new textToSpeech.TextToSpeechClient({ credentials: { client_email: creds.client_email, private_key: creds.private_key }, projectId: creds.project_id });
    return _gcpClient;
  }
  throw new Error("GCP credentials missing.");
}

async function ttsTrToWav(text, wavPath) {
  const voiceName = process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-D";
  try {
    const client = getGcpClient();
    const [response] = await client.synthesizeSpeech({
      input: { text: String(text || "") },
      voice: { languageCode: "tr-TR", name: voiceName },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.0, pitch: 0 },
    });
    await writeFileSafe(wavPath, Buffer.from(response.audioContent));
  } catch (e) {
    if (!openai) throw e;
    const resp = await openai.audio.speech.create({ model: "gpt-4o-mini-tts", voice: "marin", input: String(text || ""), response_format: "wav" });
    await writeFileSafe(wavPath, Buffer.from(await resp.arrayBuffer()));
  }
}

// ---------- VIDEO RENDER (STABILIZE EDİLMİŞ) ----------

async function imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan = {}, ctaPath = null) {
  const W = 1280;
  const H = 720;
  const fps = 30;
  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur);

  const zoomMin = 1.0;
  const zoomMax = 1.1;
  const zoomPeriodSec = 15;
  const denom = fps * zoomPeriodSec;

  const bgCount = bgPaths.length;
  const segDur = total / bgCount;

  const args = ["-y", "-loglevel", "warning", "-sws_flags", "lanczos+accurate_rnd"];

  // BG Inputs: -framerate ekleyerek jitter önleniyor
  for (let i = 0; i < bgCount; i++) {
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(segDur + 0.5), "-i", bgPaths[i]);
  }
  if (ctaPath) args.push("-loop", "1", "-t", String(total), "-i", ctaPath);
  args.push("-i", audioPath);

  const parts = [];
  for (let i = 0; i < bgCount; i++) {
    // ✅ ZOOM STABİLİZASYON FORMÜLLERİ
    const zExpr = `${zoomMin}+(${zoomMax}-${zoomMin})*(0.5-0.5*cos(2*PI*on/${denom}))`;
    const xExpr = `iw/2-(iw/zoom/2)`;
    const yExpr = `ih/2-(ih/zoom/2)`;

    parts.push(
      `[${i}:v]scale=${W*2}:${H*2}:force_original_aspect_ratio=increase,crop=${W*2}:${H*2},` +
      `zoompan=z='${zExpr}':x='trunc(${xExpr}/2)*2':y='trunc(${yExpr}/2)*2':d=1:s=${W}x${H}:fps=${fps},` +
      `setpts=PTS-STARTPTS[v${i}]`
    );
  }

  const concatIns = Array.from({ length: bgCount }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIns}concat=n=${bgCount}:v=1:a=0[vbg]`);

  let vOut = "[vbg]";
  if (ctaPath) {
    parts.push(`[${bgCount}:v]scale=600:-1,format=rgba[cta]`);
    const enableExpr = `between(t,0,4)+between(t,${total-6},${total})`;
    parts.push(`[vbg][cta]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-30:enable='${enableExpr}':format=auto[vout]`);
    vOut = "[vout]";
  }

  args.push("-filter_complex", parts.join(";"), "-map", vOut, "-map", `${ctaPath ? bgCount + 1 : bgCount}:a`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "faster", "-r", String(fps), "-movflags", "+faststart", outMp4);

  await runCmd("ffmpeg", args);
}

// --- Express Route'ları (Aynı Kalıyor) ---

async function processJob(jobId, jobDir, bgPaths, plan, ctaPath) {
  try {
    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });
    const wavs = [];
    let idx = 0;

    const addTtsClip = async (text) => {
      const p = path.join(clipsDir, `${idx++}.wav`);
      await ttsTrToWav(text, p);
      const norm = path.join(clipsDir, `${idx++}_n.wav`);
      await normalizeToWav(p, norm);
      wavs.push(norm);
    };

    const addMp3UrlClip = async (url) => {
      const p = path.join(clipsDir, `${idx++}.mp3`);
      await downloadToFile(url, p);
      const wav = path.join(clipsDir, `${idx++}.wav`);
      await normalizeToWav(p, wav);
      wavs.push(wav);
    };

    if (plan.introText) await addTtsClip(plan.introText);
    for (const s of plan.segments) {
      await addMp3UrlClip(s.arabicAudioUrl);
      await addTtsClip(s.trText);
    }

    const listPath = path.join(jobDir, "list.txt");
    await fsp.writeFile(listPath, wavs.map(p => `file '${p}'`).join("\n"));
    const concatWav = path.join(jobDir, "concat.wav");
    await concatWavs(listPath, concatWav);
    
    const finalWav = path.join(jobDir, "final.wav");
    await trimTrailingSilence(concatWav, finalWav);
    const audioM4a = path.join(jobDir, "audio.m4a");
    await wavToM4a(finalWav, audioM4a);

    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudioToMp4(bgPaths, audioM4a, outMp4, plan, ctaPath);

    const j = jobs.get(jobId);
    j.status = "done";
    j.outputPath = outMp4;
  } catch (err) {
    const j = jobs.get(jobId);
    if (j) { j.status = "error"; j.error = err.message; }
  }
}

app.post("/render10min/start", upload.any(), async (req, res) => {
  const files = req.files || [];
  const plan = JSON.parse(req.body.plan);
  const jobId = uid();
  const jobDir = path.join(os.tmpdir(), jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  const bgPaths = [];
  const bgs = files.filter(f => f.fieldname.startsWith("bg"));
  for (let i = 0; i < bgs.length; i++) {
    const p = path.join(jobDir, `bg${i}.jpg`);
    await fsp.writeFile(p, bgs[i].buffer);
    bgPaths.push(p);
  }

  jobs.set(jobId, { status: "processing", dir: jobDir, createdAt: Date.now() });
  processJob(jobId, jobDir, bgPaths, plan, null);
  res.json({ jobId });
});

app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  res.json(job ? { status: job.status, error: job.error } : { error: "not_found" });
});

app.get("/render10min/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job?.status === "done") res.sendFile(job.outputPath);
  else res.status(404).send("Not ready");
});

app.listen(PORT, () => console.log(`Server port: ${PORT}`));
