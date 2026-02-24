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

// JSON body parser ekleyelim (bazı durumlarda request body okumak için gerekebilir)
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 50 * 1024 * 1024),
    files: 15,
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
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${bin} failed (code=${code}):\n${err}`));
    });
  });
}

async function ffprobeDurationSec(filePath) {
  try {
    const args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath];
    const { out } = await runCmd("ffprobe", args);
    return Number(String(out).trim()) || 0;
  } catch { return 0; }
}

async function normalizeToWav(inPath, outWav) {
  await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-i", inPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
}

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
  throw new Error("GCP credentials missing.");
}

async function ttsTrToWav(text, wavPath) {
  const client = getGcpClient();
  const [response] = await client.synthesizeSpeech({
    input: { text: String(text || "") },
    voice: { languageCode: "tr-TR", name: process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-D" },
    audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.0 },
  });
  await fsp.mkdir(path.dirname(wavPath), { recursive: true });
  await fsp.writeFile(wavPath, Buffer.from(response.audioContent));
}

// ---------- VIDEO RENDER (STABILIZE) ----------

async function imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan = {}, ctaPath = null) {
  const W = 1280; const H = 720; const fps = 30;
  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur);
  
  // Titreme önleyici ayarlar
  const zoomMin = 1.0;
  const zoomMax = 1.1;
  const zoomPeriod = fps * 15;
  const overscan = 1.1; // %10 büyük başla ki zoom pikselleri taşmasın

  const bgCount = bgPaths.length;
  const segDur = total / bgCount;

  const args = ["-y", "-loglevel", "warning", "-sws_flags", "lanczos+accurate_rnd"];
  
  bgPaths.forEach(p => args.push("-loop", "1", "-t", String(segDur + 0.5), "-i", p));
  if (ctaPath) args.push("-loop", "1", "-t", String(total), "-i", ctaPath);
  args.push("-i", audioPath);

  const parts = [];
  for (let i = 0; i < bgCount; i++) {
    // ✅ Titreme önleyici çift sayı trunc formülü
    const zExpr = `${zoomMin}+(${zoomMax}-${zoomMin})*(0.5-0.5*cos(2*PI*on/${zoomPeriod}))`;
    const xExpr = `trunc((iw-iw/zoom)/2/2)*2`;
    const yExpr = `trunc((ih-ih/zoom)/2/2)*2`;

    parts.push(
      `[${i}:v]scale=${Math.round(W*overscan)}:${Math.round(H*overscan)}:force_original_aspect_ratio=increase,crop=${Math.round(W*overscan)}:${Math.round(H*overscan)},` +
      `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps},` +
      `setsar=1,setpts=PTS-STARTPTS[v${i}]`
    );
  }

  const concatIns = Array.from({ length: bgCount }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIns}concat=n=${bgCount}:v=1:a=0[vbg]`);

  let vOut = "[vbg]";
  if (ctaPath) {
    parts.push(`[${bgCount}:v]scale=600:-1,format=rgba[cta]`);
    parts.push(`[vbg][cta]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-40:enable='between(t,0,4)+between(t,${total-6},${total})'[vout]`);
    vOut = "[vout]";
  }

  args.push("-filter_complex", parts.join(";"), "-map", vOut, "-map", `${ctaPath ? bgCount+1 : bgCount}:a`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", outMp4);

  await runCmd("ffmpeg", args);
}

// --- Job Processing ---

async function processJob(jobId, jobDir, bgPaths, plan, ctaPath) {
  const j = jobs.get(jobId);
  try {
    j.stage = "audio_prep";
    const clipsDir = path.join(jobDir, "clips");
    const wavs = [];
    
    // Intro
    if (plan.introText) {
      const p = path.join(clipsDir, "intro.wav");
      await ttsTrToWav(plan.introText, p);
      wavs.push(p);
    }

    // Segments (Arapça + Türkçe)
    for (let i = 0; i < plan.segments.length; i++) {
      j.stage = `segment_${i+1}`;
      const s = plan.segments[i];
      const arWav = path.join(clipsDir, `ar_${i}.wav`);
      const res = await fetch(s.arabicAudioUrl);
      const buf = await res.arrayBuffer();
      await fsp.writeFile(path.join(clipsDir, `ar_${i}.mp3`), Buffer.from(buf));
      await normalizeToWav(path.join(clipsDir, `ar_${i}.mp3`), arWav);
      wavs.push(arWav);

      const trWav = path.join(clipsDir, `tr_${i}.wav`);
      await ttsTrToWav(s.trText, trWav);
      wavs.push(trWav);
    }

    j.stage = "concat_audio";
    const listPath = path.join(jobDir, "list.txt");
    await fsp.writeFile(listPath, wavs.map(p => `file '${p}'`).join("\n"));
    const finalAudio = path.join(jobDir, "final.wav");
    await runCmd("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", finalAudio]);

    j.stage = "rendering";
    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudioToMp4(bgPaths, finalAudio, outMp4, plan, ctaPath);

    j.status = "done";
    j.outputPath = outMp4;
    j.stage = "completed";
  } catch (err) {
    j.status = "error";
    j.error = err.message;
  }
}

// --- ENDPOINTS ---

app.get("/health", (req, res) => res.send("OK"));

app.post("/render10min/start", upload.any(), async (req, res) => {
  try {
    const plan = JSON.parse(req.body.plan);
    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    const bgPaths = [];
    const files = req.files || [];
    const bgs = files.filter(f => f.fieldname.startsWith("bg") || f.fieldname === "image");
    
    for (let i = 0; i < bgs.length; i++) {
      const p = path.join(jobDir, `bg${i}.jpg`);
      await fsp.writeFile(p, bgs[i].buffer);
      bgPaths.push(p);
    }

    jobs.set(jobId, { status: "processing", stage: "start", createdAt: Date.now(), dir: jobDir });
    processJob(jobId, jobDir, bgPaths, plan, null);

    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 404 ALDIĞIN YER BURASI - ROTALARI KONTROL ET
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found. It might have expired or server restarted." });
  res.json({ status: job.status, stage: job.stage, error: job.error });
});

app.get("/render10min/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job?.status === "done") res.sendFile(job.outputPath);
  else res.status(404).json({ error: "Not found or not ready" });
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
