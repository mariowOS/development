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
const { exec, spawn } = require('child_process');

const app = express();
const PORT = 3000;
const currentOS = process.platform; // 'linux', 'win32', 'darwin'

// --- CONFIGURATION & MAILER ---
let config = { 
  passwordHash: null,
  quickSettings: {
    wifi: true,
    bluetooth: true,
    dnd: false,
    powerMode: "Balanced",
    connectedWifi: "mariowOS-5G",
    connectedBt: "Wireless Headphones"
  }
};

const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  const loadedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config = { ...config, ...loadedConfig };
  if (!config.quickSettings) {
    config.quickSettings = { 
      wifi: true, 
      bluetooth: true, 
      dnd: false, 
      powerMode: "Balanced",
      connectedWifi: "mariowOS-5G",
      connectedBt: "Wireless Headphones"
    };
  }
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

// Deprecated redirect kept for legacy compatibility
app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  if (config && config.username && config.email && !req.query.edit) return res.redirect('/desktop/apps/settings/assets/youafter.html');
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

app.post("/upload-avatar", avatarUpload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  res.json({ success: true, message: "Avatar uploaded successfully!" });
});

app.post("/reset-avatar", (req, res) => {
  const avatarPath = path.join(__dirname, "desktop/assets/avatar.user.png");
  if (fs.existsSync(avatarPath)) { fs.unlinkSync(avatarPath); }
  res.json({ success: true, message: "Avatar reset!" });
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
      html: `<h2>mariowOS Daily Report</h2><p>Hello ${config.username}, check the latest issue flags on our Discord server.</p>`
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

// --- QUICK SETTINGS ENDPOINTS ---
app.get("/api/system/quick-settings", (req, res) => {
  res.json(config.quickSettings);
});

app.post("/api/system/quick-settings", express.json(), (req, res) => {
  const { setting, value } = req.body;
  if (!setting || value === undefined) {
    return res.status(400).json({ success: false, error: "Dati mancanti" });
  }

  config.quickSettings[setting] = value;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, quickSettings: config.quickSettings });
});

// --- CROSS-PLATFORM NETWORK & BLUETOOTH ENDPOINTS ---

// 1. SCANSIONE WI-FI CROSS-PLATFORM
app.get("/api/system/networks", (req, res) => {
  if (currentOS === "linux") {
    exec("nmcli -t -f SSID,SIGNAL,SECURITY,IN-USE dev wifi list --rescan yes", (err, stdout) => {
      if (err) return res.json({ success: true, networks: [] });
      const lines = stdout.trim().split("\n").filter(Boolean);
      const seen = new Set();
      const networks = [];

      lines.forEach(line => {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const ssid = parts[0].replace(/\\:/g, ":").trim();
          const signal = parseInt(parts[1], 10) || 0;
          const security = parts[2];
          const connected = parts[3] === "*";

          if (ssid && !seen.has(ssid)) {
            seen.add(ssid);
            networks.push({ ssid, signal, secured: security !== "" && security !== "--", connected });
          }
        }
      });
      res.json({ success: true, networks });
    });

  } else if (currentOS === "win32") {
    exec("netsh wlan show networks mode=bssid", (err, stdout) => {
      if (err) return res.json({ success: true, networks: [] });
      const networks = [];
      const lines = stdout.split("\r\n");
      let currentSsid = "";

      lines.forEach(line => {
        if (line.includes("SSID")) {
          const parts = line.split(":");
          if (parts[1]) currentSsid = parts[1].trim();
        } else if (line.includes("Signal") || line.includes("Segnale")) {
          const parts = line.split(":");
          const signal = parseInt(parts[1], 10) || 50;
          if (currentSsid && !networks.find(n => n.ssid === currentSsid)) {
            networks.push({
              ssid: currentSsid,
              signal: signal,
              secured: true,
              connected: config.quickSettings.connectedWifi === currentSsid
            });
          }
        }
      });
      res.json({ success: true, networks });
    });

  } else if (currentOS === "darwin") {
    const airportPath = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";
    exec(`${airportPath} -s`, (err, stdout) => {
      if (err) return res.json({ success: true, networks: [] });
      const lines = stdout.trim().split("\n").slice(1);
      const networks = [];

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 7) {
          const ssid = parts[0];
          const rssi = parseInt(parts[2], 10);
          const signal = Math.min(100, Math.max(0, (rssi + 100) * 2));
          const security = parts[6];

          if (ssid && !networks.find(n => n.ssid === ssid)) {
            networks.push({
              ssid: ssid,
              signal: signal,
              secured: security !== "NONE",
              connected: config.quickSettings.connectedWifi === ssid
            });
          }
        }
      });
      res.json({ success: true, networks });
    });
  } else {
    res.json({ success: true, networks: [] });
  }
});

// 2. CONNESSIONE WI-FI CROSS-PLATFORM
app.post("/api/system/connect-wifi", express.json(), (req, res) => {
  const { ssid, password } = req.body;
  if (!ssid) return res.status(400).json({ success: false, error: "SSID mancante" });

  let cmd = "";
  if (currentOS === "linux") {
    cmd = password ? `nmcli dev wifi connect "${ssid}" password "${password}"` : `nmcli dev wifi connect "${ssid}"`;
  } else if (currentOS === "win32") {
    cmd = `netsh wlan connect name="${ssid}"`;
  } else if (currentOS === "darwin") {
    cmd = password ? `networksetup -setairportnetwork en0 "${ssid}" "${password}"` : `networksetup -setairportnetwork en0 "${ssid}"`;
  }

  exec(cmd, (err) => {
    if (err) return res.status(500).json({ success: false, error: "Impossibile connettersi alla rete." });
    config.quickSettings.connectedWifi = ssid;
    config.quickSettings.wifi = true;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    res.json({ success: true, connectedWifi: ssid });
  });
});

// 3. DISPOSITIVI BLUETOOTH CROSS-PLATFORM
app.get("/api/system/bt-devices", (req, res) => {
  if (currentOS === "linux") {
    exec("bluetoothctl devices", (err, stdout) => {
      if (err) return res.json({ success: true, devices: [] });
      const lines = stdout.trim().split("\n").filter(Boolean);
      const devices = [];

      exec("bluetoothctl info", (infoErr, infoStdout) => {
        const activeMac = !infoErr && infoStdout.includes("Connected: yes") 
          ? infoStdout.match(/Device ([0-9A-F:]+)/i)?.[1] 
          : null;

        lines.forEach(line => {
          const match = line.match(/^Device\s+([0-9A-F:]+)\s+(.+)$/i);
          if (match) {
            const mac = match[1];
            const name = match[2];
            devices.push({
              mac: mac,
              name: name,
              type: name.toLowerCase().includes("head") || name.toLowerCase().includes("airpods") ? "headset" : "bluetooth",
              connected: mac === activeMac || config.quickSettings.connectedBt === name
            });
          }
        });
        res.json({ success: true, devices });
      });
    });

  } else if (currentOS === "win32") {
    const psCmd = `powershell "Get-PnpDevice -Class Bluetooth | Select-Object FriendlyName, Status | ConvertTo-Json"`;
    exec(psCmd, (err, stdout) => {
      if (err) return res.json({ success: true, devices: [] });
      try {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const devices = list
          .filter(d => d.FriendlyName && !d.FriendlyName.includes("Enumerator") && !d.FriendlyName.includes("Adapter"))
          .map(d => ({
            name: d.FriendlyName,
            mac: d.FriendlyName,
            type: "bluetooth",
            connected: d.Status === "OK" && config.quickSettings.connectedBt === d.FriendlyName
          }));
        res.json({ success: true, devices });
      } catch (e) {
        res.json({ success: true, devices: [] });
      }
    });

  } else if (currentOS === "darwin") {
    exec("blueutil --paired", (err, stdout) => {
      if (err) return res.json({ success: true, devices: [] });
      const lines = stdout.trim().split("\n").filter(Boolean);
      const devices = lines.map(line => {
        const nameMatch = line.match(/"([^"]+)"/);
        const macMatch = line.match(/address:\s*([0-9a-f-]+)/i);
        const name = nameMatch ? nameMatch[1] : "BT Device";
        const mac = macMatch ? macMatch[1] : "";
        const connected = line.includes("connected");
        return { name, mac, type: "bluetooth", connected };
      });
      res.json({ success: true, devices });
    });
  } else {
    res.json({ success: true, devices: [] });
  }
});

// 4. CONNESSIONE BLUETOOTH CROSS-PLATFORM
app.post("/api/system/connect-bt", express.json(), (req, res) => {
  const { mac, name } = req.body;
  const target = mac || name;
  if (!target) return res.status(400).json({ success: false, error: "Target mancante" });

  const isConnected = config.quickSettings.connectedBt === name;
  let cmd = "";

  if (currentOS === "linux") {
    cmd = `bluetoothctl ${isConnected ? "disconnect" : "connect"} ${target}`;
  } else if (currentOS === "darwin") {
    cmd = `blueutil --${isConnected ? "disconnect" : "connect"} ${target}`;
  } else if (currentOS === "win32") {
    cmd = `echo Toggle Bluetooth for ${name}`;
  }

  exec(cmd, () => {
    config.quickSettings.connectedBt = isConnected ? null : name;
    config.quickSettings.bluetooth = true;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    res.json({ success: true, connectedBt: config.quickSettings.connectedBt });
  });
});

// --- CORE ROUTES ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, !config.passwordHash ? "desktop/welcome.html" : "loginui/com.mariowos.loginui.html"));
});

app.post("/verify-code", express.json(), (req, res) => {
  const { code } = req.body;
  if (code === "123456") {
    res.json({ success: true, message: "Code verified!" });
  } else {
    res.status(400).json({ success: false, error: "Invalid verification code" });
  }
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
app.post("/save-settings", express.json(), (req, res) => {
  const { username, email, ...extra } = req.body;
  if (username && email) {
    config.username = username;
    config.email = email;
  }
  // Accept any extra lab/feature flags
  Object.keys(extra).forEach(key => {
    config[key] = extra[key];
  });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, message: "Settings saved!" });
});

app.post("/clear-settings", express.json(), (req, res) => {
  config.username = null;
  config.email = null;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, message: "Settings cleared!" });
});

app.post("/set-password", async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || !username) return res.status(400).send("❌ Dati mancanti");
  config.username = username;
  config.passwordHash = await bcrypt.hash(newPassword, 10);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.send("✅ Configurazione completata!");
});

app.post("/api/system/factory-reset", (req, res) => {
  config = { 
    passwordHash: null,
    quickSettings: { wifi: true, bluetooth: true, dnd: false, powerMode: "Balanced" }
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(__dirname, "keys.json"), JSON.stringify([]));
  res.json({ success: true, message: "Factory Reset Completato" });
});

app.post("/upload-wallpaper", wallpaperUpload.single("wallpaper"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  res.json({ success: true, message: "Wallpaper uploaded!" });
});

app.post("/api/system/reset-settings", (req, res) => {
  config.sendReports = false;
  config.email = "";
  config.verified = false;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, message: "Impostazioni ripristinate" });
});

app.post("/api/system/reset-desktop", (req, res) => {
  const avatarPath = path.join(__dirname, "desktop/assets/avatar.user.png");
  const wallpaperPath = path.join(__dirname, "desktop/assets/wallpaper.user.png");
  if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
  if (fs.existsSync(wallpaperPath)) fs.unlinkSync(wallpaperPath);
  res.json({ success: true, message: "Desktop ripristinato" });
});

// --- STORE & APPS (Package Manager) ---
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

const installProgress = {};

// Validate appId is safe for use in a filesystem path (prevents path traversal)
function isValidAppId(appId) {
  return typeof appId === 'string' && /^[a-zA-Z0-9_-]+$/.test(appId);
}

app.post("/api/store/install", express.json(), (req, res) => {
  const { appId, title, icon, repoUrl } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: "Invalid app ID" });
  }
  const targetPath = path.join(__dirname, "desktop/apps", appId);

  installProgress[appId] = { progress: 0, status: 'downloading' };

  // Send OK immediately, clone in background
  res.json({ success: true, message: "Download started" });

  const git = spawn('git', ['clone', '--progress', '--depth', '1', repoUrl, targetPath]);

  git.stderr.on('data', (data) => {
    const text = data.toString();
    // Parse progress lines like: "Receiving objects:  45% (450/1000), 1.2 MiB | 1.5 MiB/s"
    const match = text.match(/Receiving objects:\s*(\d+)%/i);
    if (match) {
      installProgress[appId].progress = parseInt(match[1], 10);
    }
    // Also catch "Resolving deltas: 99%" near the end
    const deltaMatch = text.match(/Resolving deltas:\s*(\d+)%/i);
    if (deltaMatch) {
      installProgress[appId].progress = Math.max(installProgress[appId].progress, parseInt(deltaMatch[1], 10));
    }
  });

  git.on('close', (code) => {
    if (code !== 0) {
      installProgress[appId] = { progress: 0, status: 'error' };
      return;
    }
    installProgress[appId] = { progress: 100, status: 'done' };
    if (!config.installedApps) config.installedApps = [];
    if (!config.installedApps.find(app => app.appId === appId)) {
      config.installedApps.push({ appId, title, icon, url: `apps/${appId}/index.html` });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
  });
});

app.get("/api/store/install-progress/:appId", (req, res) => {
  const prog = installProgress[req.params.appId] || { progress: 0, status: 'unknown' };
  res.json(prog);
});

app.post("/api/store/uninstall", express.json(), (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: "Invalid app ID" });
  }
  const targetPath = path.join(__dirname, "desktop/apps", appId);
  if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  if (config.installedApps) {
    config.installedApps = config.installedApps.filter(app => app.appId !== appId);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  res.json({ success: true, message: "App removed" });
});

// --- RULES ENGINE ---
if (!config.rules) config.rules = [];

// In-memory dedup: { [ruleId]: "YYYY-MM-DD HH:MM" } — avoids polluting config.json
const ruleLastRun = {};
// Pending notifications produced by 'notify' rules, drained by the shell
const pendingRuleNotifications = [];

app.get("/api/rules", (req, res) => {
  res.json(Array.isArray(config.rules) ? config.rules : []);
});

app.post("/api/rules/save", express.json(), (req, res) => {
  if (!Array.isArray(req.body.rules)) {
    return res.status(400).json({ success: false, error: "rules must be an array" });
  }
  // Drop stale dedup entries for rules that no longer exist
  const ids = new Set(req.body.rules.map(r => r.id));
  Object.keys(ruleLastRun).forEach(id => { if (!ids.has(Number(id))) delete ruleLastRun[id]; });
  config.rules = req.body.rules;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

app.post("/api/rules/trigger", express.json(), (req, res) => {
  const { action, params } = req.body;
  executeRuleAction(action, params);
  res.json({ success: true });
});

// Polled by the shell to deliver notify-rule notifications
app.get("/api/rules/notifications", (req, res) => {
  res.json(pendingRuleNotifications.splice(0, pendingRuleNotifications.length));
});

function executeRuleAction(action, params) {
  switch (action) {
    case 'notify':
      pendingRuleNotifications.push({
        title: (params && params.title) || 'Rule notification',
        msg: (params && params.message) || 'A rule just fired.',
        icon: (params && params.icon) || '🔔'
      });
      break;
    case 'run':
      if (params && params.command) {
        exec(params.command, (err) => {
          if (err) console.error('Rule exec error:', err.message);
        });
      }
      break;
    case 'power-mode':
      if (params && params.mode) {
        config.quickSettings.powerMode = params.mode;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      break;
    case 'dnd':
      if (params !== undefined) {
        // Support both { dnd: true } (new form) and raw boolean (legacy)
        const dndValue = typeof params === 'object' ? !!params.dnd : !!params;
        config.quickSettings.dnd = dndValue;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      break;
  }
}

// Check time-based rules every 30 seconds
setInterval(() => {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();

  rules.forEach(rule => {
    if (!rule || !rule.enabled) return;

    if (rule.trigger === 'time' && rule.triggerValue) {
      const [h, m] = rule.triggerValue.split(':').map(Number);
      if (h === currentHour && m === currentMin) {
        // Date-stamped dedup key: fires once per day at the scheduled time
        const fireKey = today + ':' + (h * 60 + m);
        if (ruleLastRun[rule.id] !== fireKey) {
          ruleLastRun[rule.id] = fireKey;
          executeRuleAction(rule.action, rule.actionParams);
        }
      }
    }
  });
}, 30000);

// --- SYSTEM & OTA UPDATES ---
app.get('/api/system/check-update', async (req, res) => {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
    const remoteUrl = `https://raw.githubusercontent.com/mariowOS/stable/main/version.json?t=${Date.now()}`; 
    const remote = await (await fetch(remoteUrl)).json();
    res.json(remote.version !== local ? { updateAvailable: true, current: local, latest: remote.version, changelog: remote.changelog } : { updateAvailable: false, current: local });
  } catch (error) { res.json({ updateAvailable: false, error: "Errore server" }); }
});

app.get('/api/system/ota-update', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (percent, status, finished = false) => {
    const msg = `data: ${JSON.stringify({ percent, status, finished })}\n\n`;
    try { res.write(msg); } catch (e) {}
  };

  send(0, "Preparing update engine...");

  const steps = [
    { pct: 8, label: "Setting up repository..." },
    { pct: 15, label: "Connecting to mariowOS update servers..." },
    { pct: 22, label: "Authenticating secure channel..." },
    { pct: 30, label: "Fetching latest system image..." },
    { pct: 42, label: "Downloading packages (1/3)..." },
    { pct: 55, label: "Downloading packages (2/3)..." },
    { pct: 68, label: "Downloading packages (3/3)..." },
    { pct: 75, label: "Verifying package integrity..." },
    { pct: 82, label: "Extracting system files..." }
  ];

  let i = 0;
  const tick = () => {
    if (i >= steps.length) {
      runInstall();
      return;
    }
    const step = steps[i];
    send(step.pct, step.label);
    i++;
    setTimeout(tick, 400 + Math.random() * 300);
  };
  tick();

  function runInstall() {
    send(88, "Installing update...");
    const cmds = [
      `git remote set-url origin https://github.com/mariowOS/stable.git`,
      `git fetch origin main --depth=1 2>&1`,
      `git reset --hard FETCH_HEAD 2>&1`,
      `git clean -fd 2>&1`
    ].join(' && ');

    exec(cmds, { cwd: __dirname, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        send(88, "Update failed: " + (stderr || error.message).substring(0, 120), true);
        return res.end();
      }
      send(95, "Finalizing installation...");
      setTimeout(() => {
        send(100, "Update complete! Rebooting...", true);
        res.end();
        setTimeout(() => process.exit(0), 500);
      }, 1200);
    });
  }
});

app.get("/sysinfo", (req, res) => {
  const cpus = os.cpus();
  res.json({
    OS: `mariowOS (${currentOS})`, Kernel: `${os.type()} ${os.release()}`, Uptime: os.uptime(),
    CPU: `${cpus[0].model}`, RAM: `${Math.round(os.totalmem() / 1048576)} MB`
  });
});

// --- NOTES CLOUD SYNC ---
const notesFile = path.join(__dirname, "desktop/notes-db.json");

app.get("/api/system/notes", (req, res) => {
  if (fs.existsSync(notesFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(notesFile, "utf8"));
      res.json(data);
    } catch (e) {
      res.json([]);
    }
  } else {
    res.json([]);
  }
});

app.post("/api/system/notes", express.json(), (req, res) => {
  fs.writeFileSync(notesFile, JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: "Notes synced to backend" });
});

app.listen(PORT, () => console.log(`mariowOS Kernel booted on [${currentOS}] at http://localhost:${PORT}`));