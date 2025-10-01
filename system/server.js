const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");

const app = express();
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));

// Serve loginui folder
app.use("/loginui", express.static(__dirname + "/loginui"));

// Serve desktop folder (this includes /desktop/assets and /desktop/apps)
app.use("/desktop", express.static(__dirname + "/desktop"));

// Landing page → loginui
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/loginui/com.mariowos.loginui.html");
});

// Password handling
let config = { passwordHash: null };
if (fs.existsSync("config.json")) {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
}

app.post("/login", async (req, res) => {
  const { password } = req.body;
  if (!config.passwordHash) {
    return res.send("❌ No password set! Please set one first.");
  }
  const match = await bcrypt.compare(password, config.passwordHash);
  if (match) {
    res.sendFile(__dirname + "/desktop/com.mariowos.desktop.html");
  } else {
    res.send("❌ Wrong password!");
  }
});

app.post("/set-password", async (req, res) => {
  const { newPassword } = req.body;
  const hash = await bcrypt.hash(newPassword, 10);
  config.passwordHash = hash;
  fs.writeFileSync("config.json", JSON.stringify(config));
  res.send("✅ Password updated!");
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
