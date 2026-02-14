"use strict";

const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
const upload = multer({ dest: "uploads/" });

// Crash olsa bile Railway logs'a düşsün
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/render10min/health", (req, res) => res.json({ ok: true }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
function safeRmDir(dir) {
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function downloadToFile(url, outPath) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Download failed ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

/**
 * OpenAI TTS -> mp3 dosyası üretir
 * Docs: POST /v1/audio/speech  model/voice/input (+ optional response_format, speed, instructions)
 */
async function openAiTtsToFile(text, outPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env");

  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.OPENAI_TTS_VOICE || "alloy";
  const speedRaw = process.env.OPENAI_TTS_SPEED;
  const instructions = process.env.OPENAI_TTS_INSTRUCTIONS;

  const speed = speedRaw ? Number(speedRaw) : undefined;

  // 429/5xx retry
  let attempt = 0;
  while (true) {
    attempt++;

    const body = {
      model,
      voice,
      input: String(text || "").trim().length ? String(text).trim() : " ",
      response_format: "mp3",
    };

    if (typeof speed === "number" && !Number.isNaN(speed)) body.speed = speed;
    if (instructions && String(instructions).trim().length) body.instructions = String(instructions);

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      return;
    }

    const errTxt = await resp.text().catch(() => "");
    const retryable = resp.status === 429 || (resp.status >= 500 && resp.status <= 599);

    if (retryable && attempt <= 6) {
      const waitMs = Math.min(15000, 800 * Math.pow(2, attempt));
      await sleep(waitMs);
      continue;
    }

    throw new Error(`OpenAI TTS failed ${resp.status}: ${errTxt.slice(0, 500)}`);
  }
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
const jobs = new Map(); // jobId -> {status, dir, output, error, createdAt, step, done, total}

function buildJobsFromPlan(plan) {
  const arr = [];
  let order = 1;
  const pad = (n) => String(n).padStart(4, "0");

  const addTTS = (tag, text) =>
    arr.push({ kind: "tts", order: order++, fileName: `${pad(order - 1)}_${tag}.mp3`, text: text || "" });

  const addDL = (tag, url) =>
    arr.push({ kind: "download", order: order++, fileName: `${pad(order - 1)}_${tag}.mp3`, url });

  // TR intro
  addTTS("TR_INTRO", plan.introText);

  // AR bismillah (varsa)
  if (plan.useBismillahClip && plan.bismillahAudioUrl) addDL("AR_BISM", plan.bismillahAudioUrl);

  // TR sure anonsu
  addTTS("TR_SURE", plan.surahAnnouncementText);

  // her ayet: AR sonra TR
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
    st.total = work.length;
    st.done = 0;
    st.step = "audio";

    const audioFiles = [];

    // SIRALI çalıştır (rate limit'e girmesin)
    for (const j of work) {
      const out = path.join(dir, j.fileName);

      if (j.kind === "download") {
        await downloadToFile(j.url, out);
      } else {
        await openAiTtsToFile(j.text, out);
        await sleep(400);
      }

      audioFiles.push(out);
      st.done++;
    }

    // concat list
    const listPath = path.join(dir, "list.txt");
    fs.writeFileSync(
      listPath,
      audioFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8"
    );

    st.step = "concat";
    const audioOut = path.join(dir, "all.mp3");

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:a libmp3lame -b:a 128k "${audioOut}"`,
        { maxBuffer: 1024 * 1024 * 40 },
        (err, stdout, stderr) => (err ? reject(new Error((stderr || "").slice(-4000))) : resolve())
      );
    });

    st.step = "video";
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
    st.step = "done";
  } catch (e) {
    st.status = "error";
    st.error = String(e?.message || e);
    st.step = "error";
  }
}

// Job cleanup (memory leak olmasın)
setInterval(() => {
  const now = Date.now();
  for (const [id, st] of jobs.entries()) {
    if (now - (st.createdAt || now) > 2 * 60 * 60 * 1000) { // 2 saat
      safeRmDir(st.dir);
      jobs.delete(id);
    }
  }
}, 60 * 1000);

app.post("/render10min/start", upload.fields([{ name: "image", maxCount: 1 }]), async (req, res) => {
  const jobId = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `job-${jobId}-`));

  try {
    if (!req.files?.image?.[0]) return res.status(400).json({ error: "Missing image" });
    if (!req.body?.plan) return res.status(400).json({ error: "Missing plan field" });

    const plan = JSON.parse(req.body.plan);

    const tempImage = req.files.image[0].path;
    const imagePath = path.join(dir, "image.png");
    fs.renameSync(tempImage, imagePath);

    jobs.set(jobId, {
      status: "processing",
      dir,
      output: null,
      error: null,
      createdAt: Date.now(),
      step: "queued",
      done: 0,
      total: 0,
    });

    runRender10MinJob(jobId, plan, imagePath, dir);

    return res.json({ jobId, status: "processing" });
  } catch (e) {
    jobs.set(jobId, { status: "error", dir, output: null, error: String(e?.message || e), createdAt: Date.now() });
    return res.status(500).json({ error: "server error", message: String(e?.message || e) });
  }
});

app.get("/render10min/status/:id", (req, res) => {
  const st = jobs.get(req.params.id);
  if (!st) return res.status(404).json({ error: "job not found" });
  return res.json({
    jobId: req.params.id,
    status: st.status,
    step: st.step,
    done: st.done,
    total: st.total,
    error: st.error || null,
  });
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

// Yanlış endpoint çağrılarını yakala
app.post("/render10min", (req, res) => {
  return res.status(410).json({ error: "Use POST /render10min/start then poll /status and /result" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("server running on", PORT));
