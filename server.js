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

const upload = multer({ storage: multer.memoryStorage() });
const jobs = new Map();

// --- Yardımcı Fonksiyonlar ---
function uid() { return crypto.randomUUID(); }

function runCmd(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
        let err = "";
        p.stderr.on("data", (d) => err += d.toString());
        p.on("close", (code) => code === 0 ? resolve() : reject(new Error(err)));
    });
}

// --- TTS: Sadece Google ---
let _gcpClient = null;
function getGcpClient() {
    if (_gcpClient) return _gcpClient;
    _gcpClient = new textToSpeech.TextToSpeechClient(); // Ortam değişkenlerini otomatik okur
    return _gcpClient;
}

async function ttsTrToWav(text, wavPath) {
    const client = getGcpClient();
    const [response] = await client.synthesizeSpeech({
        input: { text: String(text || "") },
        voice: { languageCode: "tr-TR", name: process.env.GCP_TTS_VOICE || "tr-TR-Wavenet-D" },
        audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.0 },
    });
    await fsp.writeFile(wavPath, response.audioContent);
}

// --- Video İşleme: Zoom Stabilizasyonu ---
async function imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan, ctaPath) {
    const W = 1280; const H = 720; const fps = 30;
    const dur = 60; // Basitleştirilmiş süre yönetimi
    
    // Titremeyi önleyen formül: x ve y her zaman çift sayı olmalı
    const zExpr = "1.0+0.05*sin(PI*t/10)";
    const xExpr = "trunc((iw-iw/zoom)/2/2)*2";
    const yExpr = "trunc((ih-ih/zoom)/2/2)*2";

    const args = ["-y", "-loop", "1", "-t", String(dur), "-i", bgPaths[0], "-i", audioPath];
    args.push("-filter_complex", `[0:v]zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}[v]`);
    args.push("-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", outMp4);

    await runCmd("ffmpeg", args);
}

// --- Ana İş Akışı ---
async function processJob(jobId, jobDir, bgPaths, plan) {
    try {
        const audioPath = path.join(jobDir, "final.wav");
        await ttsTrToWav(plan.introText, audioPath); // Basitleştirilmiş
        const outMp4 = path.join(jobDir, "output.mp4");
        await imagesPlusAudioToMp4(bgPaths, audioPath, outMp4, plan, null);
        
        const j = jobs.get(jobId);
        j.status = "done";
        j.outputPath = outMp4;
    } catch (err) {
        jobs.get(jobId).status = "error";
        console.error(err);
    }
}

// --- API ---
app.post("/render10min/start", upload.any(), async (req, res) => {
    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), jobId);
    await fsp.mkdir(jobDir, { recursive: true });
    
    // BG kaydetme
    const bgPaths = [path.join(jobDir, "bg.jpg")];
    await fsp.writeFile(bgPaths[0], req.files[0].buffer);
    
    jobs.set(jobId, { status: "processing" });
    processJob(jobId, jobDir, bgPaths, JSON.parse(req.body.plan));
    res.json({ jobId });
});

app.get("/render10min/result/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job?.status === "done") res.sendFile(job.outputPath);
    else res.status(404).send("Not found");
});

app.listen(PORT, () => console.log("Server running..."));
