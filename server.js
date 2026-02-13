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

    // 1) Audio süresini al (saniye)
    const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${audio}"`;

    exec(probeCmd, (probeErr, probeStdout) => {
      if (probeErr) {
        return res.status(500).json({ error: "ffprobe failed", details: String(probeErr) });
      }

      const durationSec = Math.max(1, Math.floor(parseFloat(String(probeStdout).trim()) || 60));
      const fps = 25;
      const totalFrames = durationSec * fps;

      // Zoom ayarları
      const zMin = 1.0;
      const zMax = 1.12; // zoom-in hedefi (istersen 1.08 - 1.20 arası)
      const halfFrames = Math.floor(totalFrames / 2);

      // 2) İki yarıyı ayrı üretip concat ile birleştir
      // İlk yarı: zoom in
      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex ` +
        `"` +
        // Video source scale
        `[0:v]scale=1280:-2,` +
        // 1. parça (zoom in)
        `zoompan=z='if(lte(on,${halfFrames}),${zMin}+(${zMax}-${zMin})*(on/${halfFrames}),${zMax})':` +
        `d=1:s=1280x720:fps=${fps},` +
        // Zamanı ikiye böl: ilk yarı / ikinci yarı
        `split=2[v1][v2];` +
        // v1 = ilk yarı (0..halfFrames)
        `[v1]trim=0:${halfFrames / fps},setpts=PTS-STARTPTS[v_in];` +
        // v2 = ikinci yarı (zoom out) (halfFrames..end)
        `[v2]trim=${halfFrames / fps}:${durationSec},setpts=PTS-STARTPTS,` +
        `zoompan=z='${zMax}-(${zMax}-${zMin})*(on/${Math.max(1, totalFrames - halfFrames)})':d=1:s=1280x720:fps=${fps}[v_out];` +
        // concat
        `[v_in][v_out]concat=n=2:v=1:a=0[v]" ` +
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
            stderr: (stderr || "").slice(-4000)
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
