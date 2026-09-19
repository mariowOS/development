// mariowOS Backend (kernel/server.js) - (C) 2026 mariowstech and the mariowOS team 
// Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
// Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 

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
const currentOS = process.platform;

function getRawGithubUrl(repoUrl) {
  if (!repoUrl) return null;
  const cleanUrl = repoUrl.replace(/\.git$/, '');
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? `https://raw.githubusercontent.com/${match[1]}/main/icon.png` : null;
}

function getRawGithubEulaUrls(repoUrl) {
  if (!repoUrl) return [];
  const cleanUrl = repoUrl.replace(/\.git$/, '');
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return [];
  const files = ['EULA.txt', 'LICENSE', 'LICENSE.txt', 'EULA', 'eula.txt', 'license.txt'];
  const branches = ['main', 'master'];
  let urls = [];
  for (let b of branches) {
    for (let f of files) {
      urls.push(`https://raw.githubusercontent.com/${match[1]}/${b}/${f}`);
    }
  }
  return urls;
}

// --- CONFIGURATION & MAILER ---
let config = { 
  passwordHash: null,
  quickSettings: {
    wifi: true,
    bluetooth: true,
    dnd: false,
    powerMode: "Balanced",
    connectedWifi: "Wi-Fi",
    connectedBt: "Bluetooth",
    volume: 50,
    isEthernet: false
  }
};

const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  const loadedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config = { ...config, ...loadedConfig };
  config.quickSettings = { 
    wifi: true, 
    bluetooth: true, 
    dnd: false, 
    powerMode: "Balanced",
    connectedWifi: "Wi-Fi", 
    connectedBt: "Bluetooth",
    isEthernet: false,
    ...(loadedConfig.quickSettings || {}) 
  };
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: "confirmation.mariowos@gmail.com", pass: "eapv psur ruuk yrrf" },
  tls: { rejectUnauthorized: false }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  if (config && config.username && config.email && !req.query.edit) return res.redirect('/desktop/apps/settings/assets/youafter.html');
  next();
});

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

app.post("/api/system/set-volume", (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) return res.status(400).json({ success: false, error: "Volume mancante" });

  const volNum = Math.max(0, Math.min(100, parseInt(volume, 10)));
  let cmd = "";

  if (currentOS === "linux") {
    cmd = `amixer -D pulse sset Master ${volNum}% || amixer sset Master ${volNum}%`;
  } else if (currentOS === "darwin") {
    cmd = `osascript -e "set volume output volume ${volNum}"`;
  } else if (currentOS === "win32") {
    cmd = `echo Windows volume set to ${volNum}%`;
  }

  exec(cmd, (err) => {
    if (err) console.error("Volume sync error:", err.message);
    config.quickSettings.volume = volNum;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    res.json({ success: true, volume: volNum });
  });
});

const appIconUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, "desktop/assets")),
    filename: (req, file, cb) => {
      const safeId = req.body.id ? req.body.id.replace(/[^a-zA-Z0-9_-]/g, '') : "app";
      cb(null, `icon_${safeId}_${Date.now()}.png`);
    }
  }),
  fileFilter: (req, file, cb) => cb(null, ["image/png", "image/jpeg"].includes(file.mimetype))
});

app.get("/api/system/desktops", (req, res) => {
  try {
    const desktopDir = path.join(__dirname, "desktop");
    const files = fs.readdirSync(desktopDir);
    const desktops = files.filter(f => f.startsWith("com.mariowos.") && f.endsWith(".html") && !f.includes("loginui"));
    res.json({ success: true, desktops });
  } catch (err) {
    res.json({ success: false, desktops: ["com.mariowos.desktop.html"] });
  }
});

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


// --- QUICK SETTINGS & HARDWARE TOGGLES ---
app.get("/api/system/quick-settings", (req, res) => {
  const interfaces = os.networkInterfaces();
  let isEthernet = false;
  
  for (const [name, nets] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();
    
    // Ignore wireless and virtual adapters
    if (
      lowerName.includes('wi-fi') || 
      lowerName.includes('wlan') || 
      lowerName.includes('wireless') || 
      lowerName.includes('virtual') || 
      lowerName.includes('vbox') || 
      lowerName.includes('vmware') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('hyper-v') ||
      lowerName.includes('tailscale') ||
      lowerName.includes('zerotier') ||
      lowerName.includes('vpn') ||
      lowerName.includes('bluetooth')
    ) continue;

    if (currentOS === 'darwin' && lowerName === 'en0') continue;

    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        isEthernet = true;
        break;
      }
    }
    if (isEthernet) break;
  }
  
  config.quickSettings.isEthernet = isEthernet;

  let wifiCmd = "";
  if (currentOS === "win32") {
    wifiCmd = 'netsh wlan show interfaces';
  } else if (currentOS === "darwin") {
    wifiCmd = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I';
  } else {
    wifiCmd = 'iwgetid -r';
  }

  exec(wifiCmd, (err, stdout) => {
    let realWifi = "Disconnected";
    if (!err && stdout) {
      if (currentOS === "win32") {
        const match = stdout.match(/^\s*SSID\s*:\s*(.+)$/m);
        if (match) realWifi = match[1].trim();
      } else if (currentOS === "darwin") {
        const match = stdout.match(/^\s*SSID:\s*(.+)$/m);
        if (match) realWifi = match[1].trim();
      } else {
        const match = stdout.trim();
        if (match) realWifi = match;
      }
    }
    
    config.quickSettings.connectedWifi = realWifi;
    
    if (config.quickSettings.connectedBt === "Wireless Headphones") {
       config.quickSettings.connectedBt = "On"; 
    }
    
    res.json(config.quickSettings);
  });
});

app.post("/api/system/quick-settings", (req, res) => {
  const { setting, value } = req.body;
  if (!setting || value === undefined) {
    return res.status(400).json({ success: false, error: "Dati mancanti" });
  }

  config.quickSettings[setting] = value;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  // --- HARDWARE POWER TOGGLES ---
  if (setting === 'wifi') {
    let cmd = "";
    if (currentOS === "linux") cmd = `nmcli radio wifi ${value ? 'on' : 'off'}`;
    else if (currentOS === "darwin") cmd = `networksetup -setairportpower en0 ${value ? 'on' : 'off'}`;
    else if (currentOS === "win32") cmd = `netsh interface set interface name="Wi-Fi" admin=${value ? 'enabled' : 'disabled'}`;
    exec(cmd, (err) => { if (err) console.error("Wi-Fi Hardware Toggle Error:", err.message); });
  } 
  else if (setting === 'bluetooth') {
    let cmd = "";
    if (currentOS === "linux") cmd = `rfkill ${value ? 'unblock' : 'block'} bluetooth`;
    else if (currentOS === "darwin") cmd = `blueutil -p ${value ? '1' : '0'}`;
    else if (currentOS === "win32") cmd = `powershell -command "${value ? 'Enable' : 'Disable'}-PnpDevice -Class Bluetooth -Confirm:$false"`;
    exec(cmd, (err) => { if (err) console.error("BT Hardware Toggle Error:", err.message); });
  }

  res.json({ success: true, quickSettings: config.quickSettings });
});


// --- CROSS-PLATFORM NETWORK & BLUETOOTH SCANNERS ---

app.get("/api/system/ethernet-stats", (req, res) => {
  const interfaces = os.networkInterfaces();
  const ethIfaces = [];
  
  for (const [name, nets] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();
    
    // Ignore wireless and virtual adapters
    if (
      lowerName.includes('wi-fi') || 
      lowerName.includes('wlan') || 
      lowerName.includes('wireless') || 
      lowerName.includes('virtual') || 
      lowerName.includes('vbox') || 
      lowerName.includes('vmware') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('hyper-v') ||
      lowerName.includes('tailscale') ||
      lowerName.includes('zerotier') ||
      lowerName.includes('vpn') ||
      lowerName.includes('bluetooth')
    ) continue;

    if (currentOS === 'darwin' && lowerName === 'en0') continue;

    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        ethIfaces.push({
          name: name,
          ip: net.address,
          status: 'Connected'
        });
        break;
      }
    }
  }
  res.json({ success: true, interfaces: ethIfaces });
});

// 1. WI-FI SCANNING
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

// 2. WI-FI CONNECTION
app.post("/api/system/connect-wifi", (req, res) => {
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

// 3. BLUETOOTH DEVICES
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

// 4. BLUETOOTH CONNECTION
app.post("/api/system/connect-bt", (req, res) => {
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

app.post("/verify-code", (req, res) => {
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

app.post("/save-settings", (req, res) => {
  const { username, email, ...extra } = req.body;
  if (username && email) {
    config.username = username;
    config.email = email;
  }
  Object.keys(extra).forEach(key => {
    config[key] = extra[key];
  });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, message: "Settings saved!" });
});

app.post("/clear-settings", (req, res) => {
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
  res.send("Configurazione completata!");
});

app.get("/clear-password", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.send("Password cleared! You can now log in without a password.");
});


app.post("/api/system/factory-reset", (req, res) => {
  config = { 
    passwordHash: null,
    quickSettings: { wifi: true, bluetooth: true, dnd: false, powerMode: "Balanced", isEthernet: false }
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

const REMOTE_CATALOG_URL = "https://raw.githubusercontent.com/mariowOS/store-catalog/main/store-catalog.json";
const localCatalogFile = path.join(__dirname, "store-catalog.json");

app.get("/api/store/catalog", async (req, res) => {
  let catalog = [];
  try {
    const response = await fetch(REMOTE_CATALOG_URL);
    if (response.ok) {
      catalog = await response.json();
      
      if (fs.existsSync(localCatalogFile)) {
        const localCatalog = JSON.parse(fs.readFileSync(localCatalogFile, "utf8"));
        const remoteIds = new Set(catalog.map(a => a.id));
        localCatalog.forEach(localApp => {
          if (!remoteIds.has(localApp.id)) catalog.push(localApp);
        });
      }
      fs.writeFileSync(localCatalogFile, JSON.stringify(catalog, null, 2));
    }
  } catch (err) {
    if (fs.existsSync(localCatalogFile)) {
      catalog = JSON.parse(fs.readFileSync(localCatalogFile, "utf8"));
    }
  }
  res.json(catalog);
});

app.get("/api/store/update", async (req, res) => {
  let oldCatalog = [];
  if (fs.existsSync(localCatalogFile)) oldCatalog = JSON.parse(fs.readFileSync(localCatalogFile, "utf8"));
  const oldIds = new Set(oldCatalog.map(a => a.id));

  try {
    const response = await fetch(REMOTE_CATALOG_URL);
    if (!response.ok) throw new Error("Fetch failed");
    const remoteCatalog = await response.json();
    
    let addedCount = 0;
    remoteCatalog.forEach(app => { if (!oldIds.has(app.id)) addedCount++; });
    
    const remoteIds = new Set(remoteCatalog.map(a => a.id));
    oldCatalog.forEach(localApp => {
      if (!remoteIds.has(localApp.id)) remoteCatalog.push(localApp);
    });

    fs.writeFileSync(localCatalogFile, JSON.stringify(remoteCatalog, null, 2));
    res.json({ success: true, addedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch remote catalog" });
  }
});

app.get("/api/store/check-upgrades", (req, res) => {
  const installedApps = config.installedApps || [];
  const upgrades = [];
  let checksPending = installedApps.length;
  if (checksPending === 0) return res.json({ success: true, upgrades: [] });

  let checkDone = 0;
  installedApps.forEach(app => {
     const targetPath = path.join(__dirname, "desktop/apps", app.appId);
     if (fs.existsSync(targetPath)) {
        exec('git fetch origin && git status -uno', { cwd: targetPath }, (err, stdout) => {
           if (!err && stdout.includes('Your branch is behind')) upgrades.push(app.appId);
           checkDone++;
           if (checkDone === checksPending) res.json({ success: true, upgrades });
        });
     } else {
        checkDone++;
        if (checkDone === checksPending) res.json({ success: true, upgrades });
     }
  });
});

app.post("/api/store/do-upgrade", (req, res) => {
  const installedApps = config.installedApps || [];
  let count = 0;
  let checksPending = installedApps.length;
  if (checksPending === 0) return res.json({ success: true, count: 0 });

  let checkDone = 0;
  installedApps.forEach(app => {
     const targetPath = path.join(__dirname, "desktop/apps", app.appId);
     if (fs.existsSync(targetPath)) {
        exec('git pull', { cwd: targetPath }, (err, stdout) => {
           if (!err && !stdout.includes('Already up to date')) count++;
           checkDone++;
           if (checkDone === checksPending) res.json({ success: true, count });
        });
     } else {
        checkDone++;
        if (checkDone === checksPending) res.json({ success: true, count });
     }
  });
});

app.post("/api/store/publish", appIconUpload.single("iconFile"), (req, res) => {
  try {
    const { id, title, developer, desc, repoUrl, icon, eula } = req.body;
    if (!id || !title || !developer || !desc || !repoUrl) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    let iconPath = "📦";
    if (req.file) {
      iconPath = `/desktop/assets/${req.file.filename}`;
    } else if (icon) {
      iconPath = icon;
    } else {
      iconPath = getRawGithubUrl(repoUrl) || "📦";
    }

    const newApp = { id, title, developer, desc, repoUrl, icon: iconPath };
    if (eula) newApp.eula = eula;

    let catalog = [];
    if (fs.existsSync(localCatalogFile)) {
      catalog = JSON.parse(fs.readFileSync(localCatalogFile, "utf8"));
    }
    
    catalog = catalog.filter(a => a.id !== id);
    catalog.push(newApp);
    
    fs.writeFileSync(localCatalogFile, JSON.stringify(catalog, null, 2));
    res.json({ success: true, app: newApp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/store/eula", async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl || repoUrl === 'local') return res.json({ eula: null });
  
  const urls = getRawGithubEulaUrls(repoUrl);
  if (urls.length === 0) return res.json({ eula: null });

  try {
    const eulaText = await Promise.any(urls.map(async url => {
      const r = await fetch(url);
      if (!r.ok) throw new Error("Not found");
      return await r.text();
    }));
    res.json({ eula: eulaText });
  } catch (e) {
    res.json({ eula: null }); 
  }
});

const installProgress = {};
function isValidAppId(appId) {
  return typeof appId === 'string' && /^[a-zA-Z0-9_-]+$/.test(appId);
}

app.post("/api/store/install", async (req, res) => {
  const { appId, title, icon, repoUrl } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: "Invalid app ID" });

  installProgress[appId] = { progress: 0, status: 'downloading' };

  let localIconPath = icon;
  if (repoUrl && repoUrl.includes('github.com')) {
    const rawIconUrl = getRawGithubUrl(repoUrl);
    if (rawIconUrl) {
      try {
        let iconRes = await fetch(rawIconUrl);
        if (!iconRes.ok) iconRes = await fetch(rawIconUrl.replace('/main/', '/master/')); 
        if (iconRes.ok) {
          const buffer = await iconRes.arrayBuffer();
          const fileName = `icon_${appId}_${Date.now()}.png`;
          fs.writeFileSync(path.join(__dirname, "desktop/assets", fileName), Buffer.from(buffer));
          localIconPath = `/desktop/assets/${fileName}`;
        }
      } catch (e) {}
    }
  }

  const absolutePath = path.join(__dirname, "desktop/apps", appId);
  const relativeUrl = appId === "tiles" ? "com.mariowos.twm.html" : `apps/${appId}/index.html`;

  function finishInstall() {
    installProgress[appId] = { progress: 100, status: 'done' };
    
    if (appId === "tiles") {
      try {
        const sourceHtml = path.join(absolutePath, "index.html");
        const targetHtml = path.join(__dirname, "desktop", "com.mariowos.twm.html");
        if (fs.existsSync(sourceHtml)) fs.copyFileSync(sourceHtml, targetHtml);
      } catch(e) { console.error("Could not copy tiles DE to root."); }
    }

    if (!config.installedApps) config.installedApps = [];
    if (!config.installedApps.find(app => app.appId === appId)) {
      config.installedApps.push({ appId, title, icon: localIconPath, url: relativeUrl });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
    res.json({ success: true, message: "Installation complete" });
  }

  const isSingleFile = !repoUrl.endsWith(".git");
  
  if (isSingleFile) {
    try {
      const fileRes = await fetch(repoUrl);
      if (!fileRes.ok) throw new Error("Failed to fetch raw file");
      const content = await fileRes.text();
      
      if (!fs.existsSync(absolutePath)) fs.mkdirSync(absolutePath, { recursive: true });
      fs.writeFileSync(path.join(absolutePath, "index.html"), content);
      
      finishInstall();
    } catch (e) {
      installProgress[appId] = { progress: 0, status: 'error' };
      return res.status(500).json({ success: false, error: "Download failed" });
    }
  } else {
    if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath, { recursive: true, force: true });
    const git = spawn('git', ['clone', '--progress', '--depth', '1', repoUrl, absolutePath]);

    git.stderr.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/Receiving objects:\s*(\d+)%/i);
      if (match) installProgress[appId].progress = parseInt(match[1], 10);
    });

    git.on('close', (code) => {
      if (code !== 0) {
        installProgress[appId] = { progress: 0, status: 'error' };
        return res.status(500).json({ success: false, error: "Installation failed during git clone" });
      }
      finishInstall();
    });
  }
});

app.post("/api/store/uninstall", (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: "Invalid app ID" });

  const targetPath = path.join(__dirname, "desktop/apps", appId);
  if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });

  if (appId === "tiles") {
    const rootPath = path.join(__dirname, "desktop", "com.mariowos.twm.html");
    if (fs.existsSync(rootPath)) fs.unlinkSync(rootPath);
  }

  if (config.installedApps) {
    config.installedApps = config.installedApps.filter(app => app.appId !== appId);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  res.json({ success: true, message: "App removed" });
});

if (!config.rules) config.rules = [];
const ruleLastRun = {};
const pendingRuleNotifications = [];

app.get("/api/rules", (req, res) => { res.json(Array.isArray(config.rules) ? config.rules : []); });

app.post("/api/rules/save", (req, res) => {
  if (!Array.isArray(req.body.rules)) return res.status(400).json({ success: false, error: "rules must be an array" });
  const ids = new Set(req.body.rules.map(r => r.id));
  Object.keys(ruleLastRun).forEach(id => { if (!ids.has(Number(id))) delete ruleLastRun[id]; });
  config.rules = req.body.rules;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

app.post("/api/rules/trigger", (req, res) => {
  executeRuleAction(req.body.action, req.body.params);
  res.json({ success: true });
});

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
      if (params && params.command) exec(params.command, (err) => { if (err) console.error('Rule exec error:', err.message); });
      break;
    case 'power-mode':
      if (params && params.mode) {
        config.quickSettings.powerMode = params.mode;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      break;
    case 'dnd':
      if (params !== undefined) {
        config.quickSettings.dnd = typeof params === 'object' ? !!params.dnd : !!params;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      break;
  }
}

setInterval(() => {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const now = new Date();
  const currentHour = now.getHours(), currentMin = now.getMinutes();
  const today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();

  rules.forEach(rule => {
    if (!rule || !rule.enabled) return;
    if (rule.trigger === 'time' && rule.triggerValue) {
      const [h, m] = rule.triggerValue.split(':').map(Number);
      if (h === currentHour && m === currentMin) {
        const fireKey = today + ':' + (h * 60 + m);
        if (ruleLastRun[rule.id] !== fireKey) {
          ruleLastRun[rule.id] = fireKey;
          executeRuleAction(rule.action, rule.actionParams);
        }
      }
    }
  });
}, 30000);


// --- SANDBOX VM ENGINE ---
const sandboxBaseDir = path.join(__dirname, "desktop/apps/sandbox");
const activeVMs = {}; 
let currentSandboxPort = 3001;

function findServerJs(dir) {
  if (!fs.existsSync(dir)) return null;
  const queue = [dir];
  while(queue.length > 0) {
    let current = queue.shift();
    let files = fs.readdirSync(current);
    for (let f of files) {
       let fullPath = path.join(current, f);
       if (fs.statSync(fullPath).isDirectory()) { queue.push(fullPath); }
       else if (f === 'server.js') { return fullPath; }
    }
  }
  return null;
}

const sandboxUpload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(sandboxBaseDir)) fs.mkdirSync(sandboxBaseDir, { recursive: true });
      cb(null, sandboxBaseDir);
    },
    filename: (req, file, cb) => cb(null, `temp_${Date.now()}.zip`)
  })
});

app.post("/api/sandbox/upload", sandboxUpload.single("vmZip"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  
  const vmId = req.body.vmId;
  if (!vmId) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: "Virtual Machine ID is required." });
  }

  const vmDisk = path.join(sandboxBaseDir, vmId, "disk");
  
  if (fs.existsSync(vmDisk)) fs.rmSync(vmDisk, { recursive: true, force: true });
  fs.mkdirSync(vmDisk, { recursive: true });

  const zipPath = req.file.path;
  
  let extractCmd = "";
  if (process.platform === "win32") {
    extractCmd = `powershell.exe -nologo -noprofile -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${vmDisk}' -Force"`;
  } else {
    extractCmd = `unzip -o "${zipPath}" -d "${vmDisk}"`;
  }

  exec(extractCmd, (err, stdout, stderr) => {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); 
    
    if (err) {
      console.error("Extraction error:", err.message || stderr);
      return res.status(500).json({ 
        success: false, 
        error: "Failed to extract zip file. Check backend console for details." 
      });
    }
    
    res.json({ success: true, message: "VM Disk ready." });
  });
});

app.post("/api/sandbox/start", (req, res) => {
  const vmId = req.body.vmId;
  if (!vmId) return res.status(400).json({ success: false, error: "Missing VM ID." });

  if (activeVMs[vmId]) return res.json({ success: true, running: true, port: activeVMs[vmId].port });
  
  const vmDisk = path.join(sandboxBaseDir, vmId, "disk");
  const targetServerJs = findServerJs(vmDisk);
  
  if (!targetServerJs) {
    return res.status(404).json({ success: false, error: "No system kernel (server.js) found in this virtual disk." });
  }

  const vmCwd = path.dirname(targetServerJs);
  const wrapperPath = path.join(vmCwd, 'sandbox-wrapper.js');
  const assignPort = currentSandboxPort++; 

  const wrapperCode = `
    const http = require('http');
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      if (typeof args[0] === 'number') {
        args[0] = ${assignPort};
      } else if (typeof args[0] === 'object' && args[0] !== null && args[0].port) {
        args[0].port = ${assignPort};
      }
      return originalListen.apply(this, args);
    };
    require('./server.js');
  `;
  
  fs.writeFileSync(wrapperPath, wrapperCode);

  const p = spawn('node', ['sandbox-wrapper.js'], { 
     cwd: vmCwd,
     env: { ...process.env, PORT: assignPort }
  });
  
  activeVMs[vmId] = { process: p, port: assignPort };

  p.on('exit', () => { delete activeVMs[vmId]; });
  
  setTimeout(() => res.json({ success: true, running: true, port: assignPort }), 1000);
});

app.post("/api/sandbox/stop", (req, res) => {
  const vmId = req.body.vmId;
  if (vmId && activeVMs[vmId]) {
    activeVMs[vmId].process.kill();
    delete activeVMs[vmId];
  }
  res.json({ success: true, running: false });
});

app.post("/api/sandbox/delete", (req, res) => {
  const vmId = req.body.vmId;
  if (!vmId) return res.status(400).json({ success: false });

  if (activeVMs[vmId]) {
    activeVMs[vmId].process.kill();
    delete activeVMs[vmId];
  }

  const vmFolder = path.join(sandboxBaseDir, vmId);
  if (fs.existsSync(vmFolder)) {
    fs.rmSync(vmFolder, { recursive: true, force: true });
  }

  res.json({ success: true });
});

app.get("/api/sandbox/status", (req, res) => {
  const statusMap = {};
  Object.keys(activeVMs).forEach(id => {
    statusMap[id] = { running: true, port: activeVMs[id].port };
  });
  res.json({ active: statusMap });
});

// --- SYSTEM & OTA UPDATES ---
app.get('/api/system/check-update', async (req, res) => {
  try {
    const versionPath = path.join(__dirname, 'version.json');
    const local = fs.existsSync(versionPath) 
      ? JSON.parse(fs.readFileSync(versionPath, 'utf8')).version 
      : "1.0.0";
      
    const remoteUrl = `https://raw.githubusercontent.com/mariowOS/stable/main/version.json?t=${Date.now()}`; 
    const response = await fetch(remoteUrl);
    
    if (!response.ok) {
       return res.json({ updateAvailable: false, current: local, error: "Server unreachable (404/500)" });
    }
    
    const remote = await response.json();
    res.json(
      remote.version !== local 
        ? { updateAvailable: true, current: local, latest: remote.version, changelog: remote.changelog } 
        : { updateAvailable: false, current: local }
    );
  } catch (error) { 
    const versionPath = path.join(__dirname, 'version.json');
    const local = fs.existsSync(versionPath) ? JSON.parse(fs.readFileSync(versionPath, 'utf8')).version : "1.0.0";
    res.json({ updateAvailable: false, current: local, error: "Update server not reachable" }); 
  }
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
    if (i >= steps.length) { runInstall(); return; }
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

const notesFile = path.join(__dirname, "desktop/notes-db.json");
app.get("/api/system/notes", (req, res) => {
  if (fs.existsSync(notesFile)) {
    try { res.json(JSON.parse(fs.readFileSync(notesFile, "utf8"))); } catch (e) { res.json([]); }
  } else { res.json([]); }
});

app.post("/api/system/notes", (req, res) => {
  fs.writeFileSync(notesFile, JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: "Notes synced to backend" });
});

app.listen(PORT, () => console.log(`mariowOS Kernel booted on [${currentOS}] at http://localhost:${PORT}`));