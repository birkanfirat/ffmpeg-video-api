"use strict";

const express = require("express");
const multer = require("multer");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const app = express();
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/render10min/health", (req, res) => res.json({ ok: true, route: "render10min" }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
function safeRmDir(dir) {
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runSpawn(cmd, args, { input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));

    let timer;
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch {}
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    p.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-2000)}`));
    });

    if (input !== undefined) {
      p.stdin.write(String(input));
    }
    p.stdin.end();
  });
}

async function downloadToFile(url, outPath) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Download failed ${resp.status}: ${txt.slice(0, 300)}`);
  }
  if (!resp.body) throw new Error("Download response has no body");

  const nodeStream = Readable.fromWeb(resp.body);
  await pipeline(nodeStream, fs.createWriteStream(outPath));
}

async function turkishTtsToMp3(text, outMp3) {
  const wav = outMp3.replace(/\.mp3$/i, ".wav");
  const speed = process.env.ESPEAK_SPEED || "150"; // istersen Railway env ile değiştir

  // espeak-ng stdin'den okuyup wav üretir
  await runSpawn("espeak-ng", ["-v", "tr", "-s", speed, "-w", wav], {
    input: (text && String(text).trim().length ? text : " "),
    timeoutMs: 120000
  });

  // wav -> mp3
  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -y -i "${wav}" -ac 2 -ar 44100 -b:a 128k "${outMp3}"`,
      { maxBuffer: 1024 * 1024 * 20 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || "").slice(-2000))) : resolve())
    );
  });

  safeUnlink(wav);
}

// -------------------- /render (eski) --------------------
app.post("/render", upload.fields([{ name: "image" }, { name: "audio" }]), (req, res) => {
  try {
    if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
      return res.status(400).json({ error: "Missing required files", got: Object.keys(req.files || {}) });
    }

    const image = req.files.image[0].path;
    const audio = req.files.audio[0].path;
    const output = "output.mp4";

    let zoomSpeed = parseFloat(req.query.zoomSpeed);
    if (isNaN(zoomSpeed)) zoomSpeed = 0.0003;
    zoomSpeed = Math.max(0.00005, Math.min(zoomSpeed, 0.002));

    const cmd =
      `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
      `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=1:s=1280x720:fps=25[v]" ` +
      `-map "[v]" -map 1:a ` +
      `-c:v libx264 -preset veryfast -crf 30 ` +
      `-c:a aac -b:a 128k -ac 2 -ar 44100 ` +
      `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 40 }, (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({ error: "ffmpeg failed", stderr: (stderr || "").slice(-4000) });
      }
      res.download(output, () => {
        safeUnlink(image);
        safeUnlink(audio);
        safeUnlink(output);
      });
    });
  } catch (e) {
    return res.status(500).json({ error: "server error", message: String(e?.message || e) });
  }
});

// -------------------- render10min job sistemi --------------------
const jobs = new Map(); // jobId -> {status, dir, output, error, createdAt}
const MAX_JOB_MS = Number(process.env.MAX_JOB_MS || 45 * 60 * 1000); // 45dk

function buildJobsFromPlan(plan) {
  const arr = [];
  let order = 1;
  const pad = (n) => String(n).padStart(4, "0");

  function addTTS(tag, text) {
    arr.push({ kind: "tts", order, fileName: `${pad(order)}_${tag}.mp3`, text: text || "" });
    order++;
  }
  function addDL(tag, url) {
    arr.push({ kind: "download", order, fileName: `${pad(order)}_${tag}.mp3`, url });
    order++;
  }

  // önce TR intro
  addTTS("TR_INTRO", plan.introText);

  // sonra varsa AR bismillah
  if (plan.useBismillahClip && plan.bismillahAudioUrl) addDL("AR_BISM", plan.bismillahAudioUrl);

  // sure anons TR
  addTTS("TR_SURE", plan.surahAnnouncementText);

  // her ayet: AR mp3 -> TR TTS
  for (const s of plan.segments || []) {
    if (!s?.arabicAudioUrl) continue;
    addDL(`AR_${String(s.ayah).padStart(3, "0")}`, s.arabicAudioUrl);
    addTTS(`TR_${String(s.ayah).padStart(3, "0")}`, s.trText);
  }

  // TR outro
  addTTS("TR_OUTRO", plan.outroText);

  return arr;
}

async function runRender10MinJob(jobId, plan, imagePath, dir) {
  const st = jobs.get(jobId);
  if (!st) return;

  try {
    const work = buildJobsFromPlan(plan);
    const audioFiles = [];

    for (const j of work) {
      const out = path.join(dir, j.fileName);
      if (j.kind === "download") {
        await downloadToFile(j.url, out);
      } else {
        await turkishTtsToMp3(j.text, out);
        await sleep(250); // hafif throttle
      }
      audioFiles.push(out);
    }

    // concat list
    const listPath = path.join(dir, "list.txt");
    fs.writeFileSync(
      listPath,
      audioFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8"
    );

    const audioOut = path.join(dir, "all.mp3");
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:a libmp3lame -b:a 128k "${audioOut}"`,
        { maxBuffer: 1024 * 1024 * 40 },
        (err, stdout, stderr) => (err ? reject(new Error((stderr || "").slice(-4000))) : resolve())
      );
    });

    // video
    const output = path.join(dir, "output.mp4");
    const zoomSpeed = 0.00025;

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioOut}" ` +
          `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=1:s=1280x720:fps=25[v]" ` +
          `-map "[v]" -map 1:a -c:v libx264 -preset veryfast -crf 30 ` +
          `-c:a aac -b:a 128k -ac 2 -ar 44100 -shortest -pix_fmt yuv420p -movflags +faststart "${output}"`,
        { maxBuffer: 1024 * 1024 * 60 },
        (err, stdout, stderr) => (err ? reject(new Error((stderr || "").slice(-4000))) : resolve())
      );
    });

    st.status = "done";
    st.output = output;
    st.error = null;
  } catch (e) {
    st.status = "error";
    st.error = String(e?.message || e);
  }
}

// GET ile bakınca “POST kullan” desin diye:
app.get("/render10min/start", (req, res) => res.status(405).json({ error: "Use POST /render10min/start" }));

app.post("/render10min/start", upload.fields([{ name: "image", maxCount: 1 }]), async (req, res) => {
  // tek job aynı anda (opsiyonel)
  for (const v of jobs.values()) {
    if (v.status === "processing") return res.status(429).json({ error: "A job is already processing" });
  }

  const jobId = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `job-${jobId}-`));

  try {
    if (!req.files?.image?.[0]) return res.status(400).json({ error: "Missing image" });
    if (!req.body?.plan) return res.status(400).json({ error: "Missing plan field" });

    const plan = JSON.parse(req.body.plan);

    const tempImage = req.files.image[0].path;
    const ext = path.extname(req.files.image[0].originalname || "") || ".png";
    const imagePath = path.join(dir, `image${ext}`);
    fs.renameSync(tempImage, imagePath);

    jobs.set(jobId, { status: "processing", dir, output: null, error: null, createdAt: Date.now() });

    // async başlat
    setImmediate(() => runRender10MinJob(jobId, plan, imagePath, dir));

    return res.json({ jobId, status: "processing" });
  } catch (e) {
    jobs.set(jobId, { status: "error", dir, output: null, error: String(e?.message || e), createdAt: Date.now() });
    return res.status(500).json({ error: "server error", message: String(e?.message || e) });
  }
});

app.get("/render10min/status/:id", (req, res) => {
  const st = jobs.get(req.params.id);
  if (!st) return res.status(404).json({ error: "job not found" });

  if (st.status === "processing" && (Date.now() - st.createdAt) > MAX_JOB_MS) {
    st.status = "error";
    st.error = "timeout";
  }

  return res.json({ jobId: req.params.id, status: st.status, error: st.error || null });
});

app.get("/render10min/result/:id", (req, res) => {
  const st = jobs.get(req.params.id);
  if (!st) return res.status(404).json({ error: "job not found" });
  if (st.status === "error") return res.status(500).json({ error: st.error || "job failed" });
  if (st.status !== "done" || !st.output) return res.status(425).json({ error: "not ready" });

  res.download(st.output, () => {
    safeRmDir(st.dir);
    jobs.delete(req.params.id);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("server running on", PORT));
