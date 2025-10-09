const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const multer = require("multer");

// middleware to parse POST data
app.use(bodyParser.urlencoded({ extended: true }));

// serve static folders
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

// load or initialize password configuration file
let config = { passwordHash: null };
const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}

// serve OOBE if no password, else login screen
app.get("/", (req, res) => {
  if (!config.passwordHash) {
    res.sendFile(path.join(__dirname, "desktop/welcome.html"));
  } else {
    res.sendFile(path.join(__dirname, "loginui/com.mariowos.loginui.html"));
  }
});

// POST route to set password (from OOBE page)
app.post("/set-password", async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.send("❌ No password provided!");

  try {
    const hash = await bcrypt.hash(newPassword, 10);
    config.passwordHash = hash;
    fs.writeFileSync(configFile, JSON.stringify(config));
    res.send("✅ Password updated!");
  } catch (err) {
    res.status(500).send("❌ Error setting password");
  }
});

// POST route to verify password (from lockscreen)
app.post("/login", async (req, res) => {
  const { password } = req.body;
  if (!config.passwordHash) return res.send("❌ No password set!");

  const match = await bcrypt.compare(password, config.passwordHash);
  if (match) {
    res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
  } else {
    res.send("❌ Wrong password!");
  }
});

// serve desktop HTML directly (only for internal links)
app.get("/desktop/com.mariowos.desktop.html", (req, res) => {
  res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// clear password url. For testing and for reset 
app.get("/clear-password", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config));
  res.send("✅ Password cleared! You can now access the OOBE page again.");
});

// wallpaper upload
const uploadDir = path.join(__dirname, "desktop", "assets");

// storage configuration (multer)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, "wallpaper.png"), // always rename
});

// file filter to allow only PNGs
const fileFilter = (req, file, cb) => {
  if (file.mimetype === "image/png") cb(null, true);
  else cb(new Error("❌ Only .png files are allowed!"));
};

const upload = multer({ storage, fileFilter });

// handler for wallpaper upload
app.post("/upload-wallpaper", upload.single("wallpaper"), (req, res) => {
  res.send("✅ Wallpaper updated successfully!");
});
