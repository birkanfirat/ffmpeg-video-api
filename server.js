const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// keyframe'ler arası lineer interpolasyon yapan zoom if zinciri üretir
function buildZoomExpr(frames, fps) {
  // Kaç segment olsun? (3-6 arası)
  const segments = Math.floor(Math.random() * 4) + 3;

  // Zoom aralığı: çok agresif olmasın
  const zMin = 1.0;
  const zMax = 1.14;

  // Keyframe frame indexleri (0..frames)
  const points = [0];
  for (let i = 1; i < segments; i++) {
    points.push(Math.floor((frames * i) / segments));
  }
  points.push(frames);

  // Zoom değerleri (smooth)
  // İlk değer 1.0 yakınında başlasın
  const zooms = [1.0 + Math.random() * 0.03];
  for (let i = 1; i < points.length; i++) {
    // Bir önceki değerden çok kopmasın diye küçük adımlarla gezdiriyoruz
    const prev = zooms[i - 1];
    const delta = (Math.random() * 0.08) - 0.04; // -0.04..+0.04
    const next = clamp(prev + delta, zMin, zMax);
    zooms.push(next);
  }

  // FFmpeg zoompan 'z=' if zinciri:
  // if(between(on,p0,p1), z0 + (z1-z0)*(on-p0)/(p1-p0), ... )
  let expr = "";
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const z0 = zooms[i].toFixed(4);
    const z1 = zooms[i + 1].toFixed(4);
    const seg = `if(between(on\\,${p0}\\,${p1})\\,(${z0})+(${z1}-${z0})*((on-${p0})/(${Math.max(1, p1 - p0)}))\\,`;
    expr += seg;
  }
  // fallback son değer
  expr += `${zooms[zooms.length - 1].toFixed(4)}` + ")".repeat(points.length - 1);

  return expr;
}

app.post("/render", upload.fields([{ name: "image" }, { name: "audio" }]), (req, res) => {
  try {
    if (!req.files?.image?.[0] || !req.files?.audio?.[0]) {
      return res.status(400).json({ error: "Missing required files", got: Object.keys(req.files || {}) });
    }

    const image = req.files.image[0].path;
    const audio = req.files.audio[0].path;
    const output = "output.mp4";

    // Audio süresini al (saniye)
    const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${audio}"`;

    exec(probeCmd, (probeErr, probeStdout) => {
      if (probeErr) {
        return res.status(500).json({ error: "ffprobe failed", details: String(probeErr) });
      }

      const durationSec = Math.max(1, Math.floor(parseFloat(String(probeStdout).trim()) || 60));
      const fps = 25;

      // CPU/RAM rahatlatmak için sabit çözünürlük
      const outW = 1280;
      const outH = 720;

      const totalFrames = durationSec * fps;

      // Rastgele ama smooth zoom ifadesi
      const zoomExpr = buildZoomExpr(totalFrames, fps);

      // Zoom merkezini ortada tut (x,y)
      const xExpr = `(iw/2)-(iw/zoom/2)`;
      const yExpr = `(ih/2)-(ih/zoom/2)`;

      const cmd =
        `ffmpeg -y -loop 1 -i "${image}" -i "${audio}" ` +
        `-filter_complex "` +
        `[0:v]scale=${outW}:-2,` +
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
