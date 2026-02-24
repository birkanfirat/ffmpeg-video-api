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

// --- Fetch fallback (Railway Node 18+ genelde var) ---
let _fetch = globalThis.fetch;
if (!_fetch) {
  try {
    // npm i node-fetch@2
    _fetch = require("node-fetch");
  } catch (e) {
    throw new Error(
      "Global fetch yok. Node 18+ kullan veya `node-fetch@2` kur."
    );
  }
}
const fetch = _fetch;

// ======================
// ✅ GCP TTS ENV MAPPING
// ======================
/**
 * Railway'deki env isimlerin:
 * - GCP_TTS_KEY_B64   : base64(service account json)
 * - GCP_TTS_VOICE     : örn "tr-TR-Wavenet-D"
 * - GCP_TTS_RATE      : örn "0.92"
 * - GCP_TTS_PITCH     : örn "0"
 *
 * Not: @google-cloud/text-to-speech ADC kullanır.
 * Biz burada key'i decode edip tmp dosyaya yazıp GOOGLE_APPLICATION_CREDENTIALS set ediyoruz.
 */
function ensureGoogleCredsFromRailwayEnv() {
  // Voice/Rate/Pitch mapping (kütüphanede kendimiz okuyacağız ama isimleri standartlaştırmak iyi)
  if (!process.env.GOOGLE_TTS_VOICE_NAME && process.env.GCP_TTS_VOICE) {
    process.env.GOOGLE_TTS_VOICE_NAME = process.env.GCP_TTS_VOICE;
  }
  if (!process.env.GOOGLE_TTS_SPEAKING_RATE && process.env.GCP_TTS_RATE) {
    process.env.GOOGLE_TTS_SPEAKING_RATE = process.env.GCP_TTS_RATE;
  }
  if (!process.env.GOOGLE_TTS_PITCH && process.env.GCP_TTS_PITCH) {
    process.env.GOOGLE_TTS_PITCH = process.env.GCP_TTS_PITCH;
  }

  // Eğer zaten set ise dokunma
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return { ok: true, mode: "file_path" };

  // Base64 key varsa decode edip dosyaya yaz
  const b64 = (process.env.GCP_TTS_KEY_B64 || "").trim();
  if (b64) {
    try {
      const cleaned = b64.replace(/\s+/g, ""); // satır sonları vs.
      const jsonText = Buffer.from(cleaned, "base64").toString("utf8");

      // JSON mu kontrol (erken hata yakalamak için)
      JSON.parse(jsonText);

      const saPath = path.join(os.tmpdir(), "gcp_sa.json");
      fs.writeFileSync(saPath, jsonText, "utf8");
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
      return { ok: true, mode: "b64_to_tmp_file" };
    } catch (e) {
      return { ok: false, error: "GCP_TTS_KEY_B64 decode/JSON parse failed: " + (e?.message || String(e)) };
    }
  }

  return {
    ok: false,
    error:
      "Google TTS credentials missing. Railway env'de `GCP_TTS_KEY_B64` set etmelisin (base64 service account JSON).",
  };
}

// Creds'i app ayağa kalkarken hazırla
const credStatus = ensureGoogleCredsFromRailwayEnv();
if (!credStatus.ok) {
  // Burada throw etmek yerine endpoint'te de kontrol edeceğiz ama boot'ta da görünür olsun
  console.error("[GCP TTS]", credStatus.error);
}

// --- Google Cloud TTS ---
const textToSpeech = require("@google-cloud/text-to-speech");
const ttsClient = new textToSpeech.TextToSpeechClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Multer: keep files in memory then write to job folder
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

// --- Google TTS (WAV) ---
function chunkText(text, maxLen = 4500) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];

  const chunks = [];
  let cur = "";
  for (const part of s.split(/\n+/g)) {
    if ((cur + "\n" + part).trim().length > maxLen) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = part;
    } else {
      cur = (cur ? cur + "\n" : "") + part;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function googleTtsToWav(text, wavPath) {
  const speakingRate = Number(process.env.GOOGLE_TTS_SPEAKING_RATE || "0.92");
  const pitch = Number(process.env.GOOGLE_TTS_PITCH || "0");
  const voiceName = (process.env.GOOGLE_TTS_VOICE_NAME || "").trim();

  const parts = chunkText(text, 4500);
  if (parts.length === 0) throw new Error("TTS text empty");

  const tmpDir = path.join(path.dirname(wavPath), "gtts_parts");
  await fsp.mkdir(tmpDir, { recursive: true });
  const partWavs = [];

  for (let i = 0; i < parts.length; i++) {
    const request = {
      input: { text: parts[i] },
      voice: voiceName
        ? { languageCode: "tr-TR", name: voiceName }
        : { languageCode: "tr-TR", ssmlGender: "NEUTRAL" },
      audioConfig: {
        audioEncoding: "LINEAR16",
        speakingRate,
        pitch,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    if (!response?.audioContent) throw new Error("Google TTS returned empty audioContent");

    const p = path.join(tmpDir, `part_${String(i).padStart(2, "0")}.wav`);
    await writeFileSafe(p, Buffer.from(response.audioContent));
    partWavs.push(p);
  }

  if (partWavs.length === 1) {
    await writeFileSafe(wavPath, await fsp.readFile(partWavs[0]));
    return;
  }

  const listPath = path.join(tmpDir, "list.txt");
  const listBody = partWavs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFileSafe(listPath, Buffer.from(listBody, "utf8"));

  const merged = path.join(tmpDir, "merged.wav");
  await concatWavs(listPath, merged);
  await writeFileSafe(wavPath, await fsp.readFile(merged));
}

/**
 * ✅ Tek görsel + ses süresi kadar video
 * - hafif zoom aç/kapat (sinus)
 * - opsiyonel CTA overlay (son X saniye)
 */
async function singleImagePlusAudioToMp4(bgPath, audioPath, outMp4, opts = {}) {
  const W = 1920;
  const H = 1080;
  const fps = 30;

  const dur = await ffprobeDurationSec(audioPath);
  const total = Math.max(1, dur || 60);

  const ctaPath = opts.ctaPath || null;
  const ctaDurationSec = Number(opts.ctaDurationSec || 6);

  const args = ["-y"];

  // bg input (audio'dan uzun tutuyoruz, -shortest ile kesilecek)
  args.push("-loop", "1", "-t", String(total + 1), "-i", bgPath);

  // optional cta input
  if (ctaPath) {
    args.push("-loop", "1", "-t", String(total + 1), "-i", ctaPath);
  }

  // audio
  const audioInputIndex = ctaPath ? 2 : 1;
  args.push("-i", audioPath);

  // zoom aç/kapat: 6 saniyede bir in-out
  const periodSec = 6;
  const periodFrames = fps * periodSec;

  const filters = [];

  filters.push(
    `[0:v]` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},` +
      `fps=${fps},` +
      `zoompan=` +
        `z='max(1.0,1.03+0.03*sin(2*PI*on/${periodFrames}))':` +
        `x='iw/2-(iw/zoom/2)':` +
        `y='ih/2-(ih/zoom/2)':` +
        `d=1:s=${W}x${H},` +
      `setsar=1,format=yuv420p` +
    `[vbg]`
  );

  if (ctaPath) {
    filters.push(`[1:v]scale=${W}:-1,format=rgba[cta]`);
    const startAt = Math.max(0, total - ctaDurationSec);
    filters.push(
      `[vbg][cta]overlay=` +
        `x=(W-w)/2:` +
        `y=H-h-40:` +
        `enable='between(t,${startAt.toFixed(3)},${total.toFixed(3)})':` +
        `format=auto,format=yuv420p[vout]`
    );
  } else {
    filters.push(`[vbg]copy[vout]`);
  }

  const filterComplex = filters.join(";");

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", `${audioInputIndex}:a`,
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

async function processJob(jobId, jobDir, bgPath, plan, ctaPath) {
  try {
    setStage(jobId, "prepare");

    if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) {
      throw new Error("Plan.segments boş veya yok");
    }
    if (!bgPath) throw new Error("BG path boş");

    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });

    const wavs = [];
    let idx = 0;

    const addTtsClip = async (text, name) => {
      const raw = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}_raw.wav`);
      const norm = path.join(clipsDir, `${String(idx++).padStart(3, "0")}_${name}.wav`);
      await googleTtsToWav(text, raw);
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

    const ctaDurationSec =
      Number(plan?.videoFx?.ctaDurationSec) ||
      Number(process.env.CTA_DURATION_SEC || 6);

    await singleImagePlusAudioToMp4(bgPath, audioM4a, outMp4, {
      ctaPath: ctaPath || null,
      ctaDurationSec,
    });

    setStage(jobId, "verify");
    const dur2 = await ffprobeDurationSec(outMp4);
    if (dur2 < 10) throw new Error(`Video duration too short: ${dur2.toFixed(2)}s`);

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
    // Her requestte bir daha kontrol (deploy sonrası env geç gelirse vs.)
    const st = ensureGoogleCredsFromRailwayEnv();
    if (!st.ok) {
      return res.status(500).json({ error: st.error });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!req.body?.plan) return res.status(400).json({ error: "Missing plan field" });

    let plan;
    try {
      plan = JSON.parse(req.body.plan);
    } catch (e) {
      return res.status(400).json({ error: "Plan JSON parse error" });
    }

    // ✅ Tek BG: bg1 (opsiyonel eski uyumluluk: image)
    const bgFile =
      files.find((f) => f?.buffer && /^bg1$/i.test(String(f.fieldname))) ||
      files.find((f) => f?.buffer && String(f.fieldname).toLowerCase() === "image");

    if (!bgFile) {
      return res.status(400).json({
        error:
          "Missing required files. Need bg1. Got: " +
          (files.map((f) => f.fieldname).join(", ") || "none"),
      });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render10min_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const bgPath = path.join(jobDir, "bg_01.png");
    await writeFileSafe(bgPath, bgFile.buffer);

    const ctaPath = await resolveCta(jobDir, files);

    jobs.set(jobId, {
      status: "processing",
      stage: "queued",
      dir: jobDir,
      createdAt: Date.now(),
    });

    setImmediate(() => processJob(jobId, jobDir, bgPath, plan, ctaPath));

    res.json({
      jobId,
      bgCount: 1,
      cta: Boolean(ctaPath),
      tts: {
        voice: process.env.GOOGLE_TTS_VOICE_NAME || null,
        rate: process.env.GOOGLE_TTS_SPEAKING_RATE || null,
        pitch: process.env.GOOGLE_TTS_PITCH || null,
      },
    });
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
