// mariowOS Backend (kernel/server.js) - (C) 2025 mariowstech and the mariowOS team 
// Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
// Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 
// This project use open source and free fonts sourced from Google Fonts. Google Fonts is a trademark of Google LCC, privacy docs are at https://developers.google.com/fonts/faq/privacy 

const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");
const cron = require('node-cron');
const nodemailer = require("nodemailer");
const { exec } = require('child_process');

const app = express();
const PORT = 3000;

// --- CONFIGURATION & MAILER ---
let config = { passwordHash: null };
const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: "confirmation.mariowos@gmail.com", pass: "eapv psur ruuk yrrf" },
  tls: { rejectUnauthorized: false }
});

// --- MIDDLEWARES ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  if (config && config.username && config.email) return res.redirect('/desktop/apps/settings/assets/youafter.html');
  next();
});

// --- UPLOAD STORAGES ---
const avatarUpload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, "desktop/assets")),
    filename: (req, file, cb) => cb(null, "avatar.user.png")
  }),
  fileFilter: (req, file, cb) => cb(null, ["image/png", "image/jpeg"].includes(file.mimetype))
});

const wallpaperUpload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname,"desktop/assets")),
    filename: (req, file, cb) => cb(null, "wallpaper.user.png")
  }),
  fileFilter: (req, file, cb) => cb(null, ["image/png", "image/jpeg"].includes(file.mimetype))
});

// --- CRON JOBS ---
let dailyEmailTask = null;
async function sendDiscordFlagsEmail() {
  if (!config.email) return;
  try {
    await transporter.sendMail({
      from: { name: "mariowOS", address: "confirmation.mariowos@gmail.com" },
      to: config.email,
      subject: "mariowOS Daily Issue Flags - Discord",
      html: `<h2>mariowOS Daily Report</h2><p>Hello ${config.username}, check the latest issue flags on our Discord server.</p>` // Semplificato qui per brevità
    });
    config.lastSent = Date.now();
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (err) { console.error('Failed to send daily email:', err); }
}

function scheduleDailyEmail() {
  if (dailyEmailTask) dailyEmailTask.stop();
  if (config.email && config.sendReports) {
    dailyEmailTask = cron.schedule('0 9 * * *', async () => await sendDiscordFlagsEmail(), { timezone: "Europe/Rome" });
  }
}
scheduleDailyEmail();

// --- CORE ROUTES ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, !config.passwordHash ? "desktop/welcome.html" : "loginui/com.mariowos.loginui.html"));
});

app.post("/login", async (req, res) => {
  const { password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  if (!currentConfig.passwordHash) return res.send("❌ No password set!");
  
  const match = await bcrypt.compare(password, currentConfig.passwordHash);
  match ? res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html")) : res.send("❌ Wrong password!");
});

app.get("/get-settings", (req, res) => {
  const safe = { ...config };
  delete safe.passwordHash;
  res.json(safe);
});

// --- SETTINGS & ACCOUNTS ---
app.post("/set-password", async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || !username) return res.status(400).send("❌ Dati mancanti");
  config.username = username;
  config.passwordHash = await bcrypt.hash(newPassword, 10);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.send("✅ Configurazione completata!");
});

app.post("/api/system/factory-reset", (req, res) => {
  config = { passwordHash: null };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(__dirname, "keys.json"), JSON.stringify([]));
  res.json({ success: true, message: "Factory Reset Completato" });
});

// --- STORE & APPS (Il Package Manager) ---
const catalogFile = path.join(__dirname, "store-catalog.json");
if (!fs.existsSync(catalogFile)) {
  fs.writeFileSync(catalogFile, JSON.stringify([{ id: 'app_sysinfo', title: 'SysMonitor', developer: 'mariowOS Team', desc: 'Advanced system monitor.', icon: '📊', repoUrl: 'https://github.com/mariowstech/sysmonitor-example.git' }], null, 2));
}

app.get("/api/store/catalog", (req, res) => res.json(JSON.parse(fs.readFileSync(catalogFile, "utf8"))));

app.post("/api/store/publish", express.json(), (req, res) => {
  const { id, title, developer, desc, icon, repoUrl } = req.body;
  if (!id || !title || !repoUrl) return res.status(400).json({ success: false, error: "Dati mancanti" });
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  if (catalog.find(app => app.id === id)) return res.status(400).json({ success: false, error: "App ID già esistente" });
  
  catalog.push({ id, title, developer: developer || 'Unknown', desc, icon: icon || '📦', repoUrl });
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  res.json({ success: true, message: "App pubblicata!" });
});

app.post("/api/store/install", express.json(), (req, res) => {
  const { appId, title, icon, repoUrl } = req.body;
  const targetPath = path.join(__dirname, "desktop/apps", appId);
  
  exec(`git clone ${repoUrl} ${targetPath}`, (error) => {
    if (error) return res.status(500).json({ success: false, error: "Download fallito" });
    if (!config.installedApps) config.installedApps = [];
    if (!config.installedApps.find(app => app.appId === appId)) {
      config.installedApps.push({ appId, title, icon, url: `apps/${appId}/index.html` });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
    res.json({ success: true, message: "App installata!" });
  });
});

app.post("/api/store/uninstall", express.json(), (req, res) => {
  const { appId } = req.body;
  const targetPath = path.join(__dirname, "desktop/apps", appId);
  if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  if (config.installedApps) {
    config.installedApps = config.installedApps.filter(app => app.appId !== appId);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  res.json({ success: true, message: "App rimossa!" });
});

// --- SYSTEM & OTA UPDATES ---
app.get('/api/system/check-update', async (req, res) => {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
    const remoteUrl = `https://raw.githubusercontent.com/mariowstech/mariowOS/main/version.json?t=${Date.now()}`; 
    const remote = await (await fetch(remoteUrl)).json();
    res.json(remote.version !== local ? { updateAvailable: true, current: local, latest: remote.version, changelog: remote.changelog } : { updateAvailable: false, current: local });
  } catch (error) { res.json({ updateAvailable: false, error: "Errore server" }); }
});

app.get('/api/system/ota-update', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (percent, status, finished = false) => res.write(`data: ${JSON.stringify({ percent, status, finished })}\n\n`);
  send(5, "Verifica canali OTA...");

  let p = 10;
  const anim = setInterval(() => {
    p += Math.floor(Math.random() * 15);
    if (p > 85) {
      clearInterval(anim);
      send(90, "Installazione pacchetti...");
      exec('git pull', { cwd: __dirname }, (error) => {
        if (error) { send(90, "Errore installazione.", true); return res.end(); }
        setTimeout(() => {
          send(100, "Aggiornamento completato!", true);
          res.end();
          process.exit(0); // Riavvia il server tramite script bash/bat
        }, 1000);
      });
    } else { send(p, `Download in corso... ${p}%`); }
  }, 600);
});

app.get("/sysinfo", (req, res) => {
  const cpus = os.cpus();
  res.json({
    OS: "mariowOS", Kernel: `${os.type()} ${os.release()}`, Uptime: os.uptime(),
    CPU: `${cpus[0].model}`, RAM: `${Math.round(os.totalmem() / 1048576)} MB`
  });
});

app.listen(PORT, () => console.log(`mariowOS Kernel booted at http://localhost:${PORT}`));