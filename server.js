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
-c:v libx264 -tune stillimage \
-c:a aac -b:a 192k \
-pix_fmt yuv420p \
-shortest ${output}
`;

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
