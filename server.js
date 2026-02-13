const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.post("/render", upload.fields([{ name: "image" }, { name: "audio" }]), (req, res) => {
  try {
    if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
      return res.status(400).json({ error: "Missing required files", got: Object.keys(req.files || {}) });
    }

    const image = req.files.image[0].path;
    const audio = req.files.audio[0].path;
    const output = "output.mp4";

    const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${audio}"`;

    exec(probeCmd, (probeErr, probeStdout) => {
      if (probeErr) return res.status(500).json({ error: "ffprobe failed", details: String(probeErr) });

      const durationSec = Math.max(1, Math.floor(parseFloat(String(probeStdout).trim()) || 60));

      const fps = 25;

      const outW = 1920;
      const outH = 1080;

      const baseW = 2400;
      const baseH = 1350;

      const zStart = 1.0;
      const zEnd = 1.06;

      const totalFrames = durationSec * fps;

      const zoomExpr = `${zStart}+(${zEnd}-${zStart})*(on/${Math.max(1, totalFrames)})`;

      // Merkezde kalsın ama TAM SAYI olsun → jitter gider
      const xExpr = `floor((iw/2)-(iw/zoom/2))`;
      const yExpr = `floor((ih/2)-(ih/zoom/2))`;

      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex "` +
        `[0:v]scale=${baseW}:${baseH}:force_original_aspect_ratio=increase,crop=${baseW}:${baseH},` +
        `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${outW}x${outH}:fps=${fps}[v]` +
        `" ` +
        `-map "[v]" -map 1:a ` +
        `-c:v libx264 -preset veryfast -crf 30 ` +
        `-c:a aac -b:a 128k -ac 2 -ar 44100 ` +
        `-shortest -pix_fmt yuv420p -movflags +faststart "${output}"`;

      exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({
            error: "ffmpeg failed",
            code: err.code,
            signal: err.signal,
            cmd,
            stderr: (stderr || "").slice(-4000),
          });
        }

        res.download(output, () => {
          try { fs.unlinkSync(image); } catch {}
          try { fs.unlinkSync(audio); } catch {}
          try { fs.unlinkSync(output); } catch {}
        });
      });
    });
  } catch (e) {
    return res.status(500).json({ error: "server error", message: String(e) });
  }
});

app.listen(3000, () => console.log("server running"));
