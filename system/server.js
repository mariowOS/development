// mariowOS Backend (kernel/server.js) - (C) 2025 mariowstech and the mariowOS team 
// Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
// Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 
// This project use open source and free fonts sourced from Google Fonts. Google Fonts is a trademark of Google LCC, privacy docs are at https://developers.google.com/fonts/faq/privacy 

const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const multer = require("multer");

const os = require("os");

// middleware to parse POST data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
// If settings already exist, redirect direct requests for the editor page to the confirmation page
app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  try {
    if (config && config.username && config.email) {
      return res.redirect('/desktop/apps/settings/assets/youafter.html');
    }
  } catch (e) {
    // ignore and fall through to static
  }
  next();
});

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

// POST route to save user settings
app.post("/save-settings", (req, res) => {
  const { username, email, language, theme } = req.body;
  
  try {
    // Update config object with new settings
    config.username = username;
    config.email = email;
    config.language = language;
    config.theme = theme;
    
    // Write updated config to file
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    
    // Send success response
    res.json({ success: true, message: "Settings saved successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Error saving settings" });
  }
});

// Fallback GET for easier debugging: return JSON instead of HTML for non-POST requests
app.get("/save-settings", (req, res) => {
  res.json({ success: false, error: "Use POST to save settings" });
});

// GET route to return current settings (hide passwordHash)
app.get('/get-settings', (req, res) => {
  try {
    const safe = Object.assign({}, config);
    if (safe.passwordHash) delete safe.passwordHash;
    res.json(safe);
  } catch (err) {
    res.status(500).json({});
  }
});

// fuckass route to verify password (from lockscreen)
// this route sucks ass but i'm too lazy to fix it, fuck you
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

// keyring host commands
const keysFile = path.join(__dirname, "keys.json");

app.post("/save-key", express.json(), (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).send("[KEYRING] E: No key provided!");

  let keys = [];
  if (fs.existsSync(keysFile)) {
    try {
      keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    } catch (e) {
      keys = [];
    }
  }

  keys.push({ key, date: new Date().toISOString() });
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));

  res.send(`[KEYRING] Key "${key}" saved to keyring!`);
});

// list all keys
app.get("/list-keys", (req, res) => {
  if (!fs.existsSync(keysFile)) return res.json([]);
  try {
    const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    res.json(keys);
  } catch (err) {
    res.status(500).json([]);
  }
});

// delete a key
app.post("/delete-key", express.json(), (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).send("[KEYRING] E: No key specified!");

  if (!fs.existsSync(keysFile)) return res.send("[KEYRING] E: No keys found!");

  let keys = [];
  try {
    keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  } catch (e) {
    return res.send("[KEYRING] E: Key file corrupted.");
  }

  const originalLength = keys.length;
  keys = keys.filter((k) => k.key !== key);

  if (keys.length === originalLength) {
    return res.send(`[KEYRING] E: Key "${key}" not found.`);
  }

  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
  res.send(`[KEYRING] Key "${key}" deleted from keyring.`);
});

app.get("/sysinfo", (req, res) => {
  try {
    const cpus = os.cpus();
    const sysInfo = {
      OS: "mariowOS v0.9",
      Kernel: os.type() + " " + os.release(),
      Uptime: os.uptime(), // seconds
      CPU: `${cpus[0].model} (${cpus.length} cores)`,
      RAM: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
      FreeRAM: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
    };
    res.json(sysInfo);
  } catch (err) {
    res.status(500).json({ error: "Failed to get system info" });
  }
});

// system info endpoint - fetch command (ask system info to host)
app.get("/sysinfo", (req, res) => {
  try {
    const cpus = os.cpus();
    const sysInfo = {
      OS: "mariowOS v0.7",
      Kernel: os.type() + " " + os.release(),
      Uptime: os.uptime(), // shown in seconds
      CPU: `${cpus[0].model} (${cpus.length} cores)`,
      RAM: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
      FreeRAM: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
    };
    res.json(sysInfo);
  } catch (err) {
    res.status(500).json({ error: "Failed to get system info" });
  }
});

// POST route to clear user settings (keep passwordHash)
app.post('/clear-settings', (req, res) => {
  try {
    if (config) {
      delete config.username;
      delete config.email;
      delete config.language;
      delete config.theme;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
    res.json({ success: true, message: 'Settings cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error clearing settings' });
  }
});

// FACTORY RESET ENDPOINT - Reset everything to original state
app.post("/api/system/factory-reset", express.json(), (req, res) => {
  try {
    console.log("[FACTORY RESET] Starting reset process...");
    
    // Reset config.json completely - passwordHash = null for fresh OOBE
    const originalConfig = { passwordHash: null };
    fs.writeFileSync(configFile, JSON.stringify(originalConfig, null, 2));
    
    // UPDATE IN-MEMORY CONFIG IMMEDIATELY
    config = originalConfig;
    console.log("[FACTORY RESET] Config updated in memory to:", config);
    
    // Clear keys.json completely
    fs.writeFileSync(keysFile, JSON.stringify([], null, 2));
    console.log("[FACTORY RESET] Keys.json cleared");
    console.log("[FACTORY RESET] All data has been cleared. passwordHash is now:", config.passwordHash);
    
    // Success response
    res.json({ success: true, message: "System has been fully reset to factory defaults", config: config });
  } catch (err) {
    console.error("[FACTORY RESET] Error:", err);
    res.status(500).json({ success: false, error: "Error during factory reset: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`mariowOS is running at http://localhost:${PORT}`);
});

app.get("/clear-password", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config));
  res.send("config.js cleared. you can now exit fallback mode (finder > exit fallback mode) ");
});

// handler for wallpaper upload
const uploadDir = path.join(__dirname, "desktop", "assets");

// storage configuration (using multer)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, "wallpaper.png"), // always rename else it will fuck itself up
});

// file filter to allow only PNGs 
const fileFilter = (req, file, cb) => {
  if (file.mimetype === "image/png") cb(null, true);
  else cb(new Error("Only .png files are allowed!")); // i'm too lazy to write a variable for all of the single image files.
};

const upload = multer({ storage, fileFilter });

// actually upload the wallpaper
app.post("/upload-wallpaper", upload.single("wallpaper"), (req, res) => {
  res.send("Wallpaper updated successfully!");
});
