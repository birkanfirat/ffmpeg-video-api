const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.post("/render", upload.fields([
  { name: "image" },
  { name: "audio" }
]), (req, res) => {

  const image = req.files.image[0].path;
  const audio = req.files.audio[0].path;
  const output = "output.mp4";

  const cmd = `
ffmpeg -loop 1 -i ${image} -i ${audio} \
-filter_complex "[0:v]scale=1280:-2,zoompan=z='min(zoom+0.0005,1.15)':d=125:s=1280x720:fps=25[v]" \
-map "[v]" -map 1:a \
-c:v libx264 -preset veryfast -crf 30 \
-c:a aac -b:a 128k \
-shortest -pix_fmt yuv420p -movflags +faststart output.mp4`;

  exec(cmd, (err) => {
    if (err) return res.status(500).send(err);

    res.download(output, () => {
      fs.unlinkSync(image);
      fs.unlinkSync(audio);
      fs.unlinkSync(output);
    });
  });
});

app.listen(3000, () => console.log("server running"));
