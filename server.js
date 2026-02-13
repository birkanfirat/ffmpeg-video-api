const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.post(
  "/render",
  upload.fields([{ name: "image" }, { name: "audio" }]),
  (req, res) => {
    try {
      if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
        return res.status(400).json({
          error: "Missing required files",
          got: Object.keys(req.files || {})
        });
      }

      const image = req.files.image[0].path;
      const audio = req.files.audio[0].path;
      const output = "output.mp4";

      // Zoom hızı parametresi
      let zoomSpeed = parseFloat(req.query.zoomSpeed);

      if (isNaN(zoomSpeed)) {
        zoomSpeed = 0.0003; // varsayılan
      }

      // Güvenli aralık
      zoomSpeed = Math.max(0.00005, Math.min(zoomSpeed, 0.002));

      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+${zoomSpeed},1.15)':d=125:s=1280x720:fps=25[v]" ` +
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
    } catch (e) {
      return res.status(500).json({ error: "server error", message: String(e) });
    }
  }
);

app.listen(3000, () => console.log("server running"));
