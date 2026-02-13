const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("server running on", PORT));
