/* server.js
 * Endpoints:
 *  POST /render10min/start   (multipart: bg1 + audio (+ optional plan JSON string))
 *  GET  /render10min/status/:jobId   -> { status: "processing"|"done"|"error", stage?, error? }
 *  GET  /render10min/result/:jobId   -> mp4 file stream
 */

"use strict";

const express = require("express");
const multer = require("multer");
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------
// In-memory job store
// ---------------------------
/**
 * jobs[jobId] = {
 *   status: "processing"|"done"|"error",
 *   stage: string,
 *   error?: string,
 *   outPath?: string,
 *   createdAt: number
 * }
 */
const jobs = Object.create(null);

// Cleanup old jobs (keep disk tidy)
const JOB_TTL_MS = 60 * 60 * 1000; // 1h
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs)) {
    if (now - (job.createdAt || now) > JOB_TTL_MS) {
      if (job.outPath) {
        fs.existsSync(job.outPath) && fs.unlink(job.outPath, () => {});
      }
      delete jobs[id];
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------
// Multer upload (disk)
// ---------------------------
const upload = multer({
  dest: path.join(os.tmpdir(), "render10min_uploads"),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB (audio+image)
  },
});

// ---------------------------
// Helpers
// ---------------------------
function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function safeUnlink(p) {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch (_) {}
}

async function safeRmDir(dir) {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (_) {}
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });

    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      const msg = `Command failed (${cmd} ${args.join(" ")}), exit=${code}\n${err || out}`;
      reject(new Error(msg));
    });
  });
}

async function ffprobeDurationSec(filePath) {
  // duration in seconds (float)
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    filePath,
  ];
  try {
    const { out } = await runCmd("ffprobe", args);
    const v = parseFloat(String(out).trim());
    if (Number.isFinite(v) && v > 0) return v;
    return null;
  } catch (_) {
    return null;
  }
}

async function normalizeImageToPng(inputPath, outPath) {
  // Convert any image to PNG (stable for ffmpeg)
  // Also strips weird color profiles that sometimes crash.
  const args = ["-y", "-i", inputPath, "-vf", "scale=iw:ih", outPath];
  await runCmd("ffmpeg", args);
  return outPath;
}

async function normalizeAudioToM4A(inputPath, outPath) {
  // This prevents "aac -shortest ... failed" cases:
  // - Some inputs have odd codecs/timebases.
  // - Normalize to AAC inside M4A with stable params.
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outPath,
  ];
  await runCmd("ffmpeg", args);
  return outPath;
}

/**
 * Single image + audio -> mp4.
 * Zoom is optional (ENABLE_ZOOM=1 or plan.enableZoom=true)
 */
async function imagePlusAudioToMp4({ imagePath, audioPath, outMp4, enableZoom }) {
  const W = 1920;
  const H = 1080;
  const fps = 30;

  const dur = await ffprobeDurationSec(audioPath);
  // If ffprobe fails, still try. But we need zoompan frame count:
  const total = Math.max(1, dur || 60);
  const frameCount = Math.ceil(total * fps);

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-i",
    audioPath,
  ];

  // Zoom effect (very light): zoom in to ~1.06 then stays capped
  // If you want "zoom in/out" oscillation, tell me—onu da eklerim.
  let filter;
  if (enableZoom) {
    filter = `
      [0:v]
      scale=${W}:${H}:force_original_aspect_ratio=increase,
      crop=${W}:${H},
      zoompan=z='min(zoom+0.0005,1.06)':
              x='iw/2-(iw/zoom/2)':
              y='ih/2-(ih/zoom/2)':
              d=${frameCount}:s=${W}x${H},
      fps=${fps},
      setsar=1,
      format=yuv420p
      [vout]
    `.replace(/\s+/g, "");
  } else {
    filter = `
      [0:v]
      scale=${W}:${H}:force_original_aspect_ratio=increase,
      crop=${W}:${H},
      fps=${fps},
      setsar=1,
      format=yuv420p
      [vout]
    `.replace(/\s+/g, "");
  }

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    // en kritik: audio bittiği an video da biter
    "-shortest",
    outMp4
  );

  await runCmd("ffmpeg", args);
}

// ---------------------------
// Routes
// ---------------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    endpoints: {
      start: "POST /render10min/start (multipart: bg1 + audio + optional plan)",
      status: "GET /render10min/status/:jobId",
      result: "GET /render10min/result/:jobId",
    },
  });
});

app.post(
  "/render10min/start",
  upload.fields([
    { name: "bg1", maxCount: 1 },
    { name: "audio", maxCount: 1 },
    { name: "plan", maxCount: 1 }, // plan can be file OR text field; we read from req.body.plan if text
  ]),
  async (req, res) => {
    const jobId = randomId();
    jobs[jobId] = { status: "processing", stage: "queued", createdAt: Date.now() };

    // respond immediately
    res.json({ jobId });

    // run async pipeline
    const workDir = path.join(os.tmpdir(), `render10min_${jobId}`);
    let outPath = null;

    try {
      await ensureDir(workDir);
      jobs[jobId].stage = "validating";

      const imgFile = req.files?.bg1?.[0];
      const audFile = req.files?.audio?.[0];

      if (!imgFile || !audFile) {
        throw new Error(
          `Missing required files. Need bg1 and audio. Got: ${Object.keys(req.files || {}).join(", ")}`
        );
      }

      // plan: may come as text field (preferred)
      let plan = {};
      if (req.body?.plan) {
        try {
          plan = JSON.parse(req.body.plan);
        } catch (e) {
          // not fatal—just ignore malformed plan
          plan = {};
        }
      }

      const enableZoom =
        plan.enableZoom === true ||
        process.env.ENABLE_ZOOM === "1";

      jobs[jobId].stage = "normalizing_media";

      const normalizedImage = path.join(workDir, "bg.png");
      const normalizedAudio = path.join(workDir, "audio.m4a");

      await normalizeImageToPng(imgFile.path, normalizedImage);
      await normalizeAudioToM4A(audFile.path, normalizedAudio);

      // Remove raw uploads early (saves disk)
      await safeUnlink(imgFile.path);
      await safeUnlink(audFile.path);

      jobs[jobId].stage = "rendering_mp4";

      outPath = path.join(workDir, "output.mp4");
      await imagePlusAudioToMp4({
        imagePath: normalizedImage,
        audioPath: normalizedAudio,
        outMp4: outPath,
        enableZoom,
      });

      jobs[jobId].status = "done";
      jobs[jobId].stage = "done";
      jobs[jobId].outPath = outPath;
    } catch (err) {
      jobs[jobId].status = "error";
      jobs[jobId].stage = "error";
      jobs[jobId].error = err?.message || String(err);

      // cleanup on error
      if (outPath) await safeUnlink(outPath);
      await safeRmDir(workDir);
      return;
    }

    // keep workDir (contains output.mp4) until TTL cleanup
  }
);

app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ status: "error", error: "Job not found" });
  }
  res.json({
    status: job.status,
    stage: job.stage,
    error: job.error || null,
  });
});

app.get("/render10min/result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "done" || !job.outPath) {
    return res.status(400).json({
      error: "Job not ready",
      status: job.status,
      stage: job.stage,
      jobError: job.error || null,
    });
  }

  if (!fs.existsSync(job.outPath)) {
    return res.status(404).json({ error: "Result file missing" });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="render_${req.params.jobId}.mp4"`
  );

  const stream = fs.createReadStream(job.outPath);
  stream.on("error", (e) => res.status(500).end(String(e)));
  stream.pipe(res);
});

// ---------------------------
// Start
// ---------------------------
app.listen(PORT, () => {
  console.log(`Render server listening on :${PORT}`);
});
