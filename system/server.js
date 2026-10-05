// mariowOS builder note: This file is part of the runtime that powers the OS. It defines how the desktop, login flow, or app behavior is built for contributors.

// mariowOS Backend (kernel/server.js) - (C) 2026 mariowstech and the mariowOS team 
// Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
// Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 

const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const cron = require('node-cron');
const nodemailer = require("nodemailer");
const childProcess = require('child_process');
// Never flash a console window on Windows for helper commands (netsh, git, powershell...).
const exec = (command, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  return childProcess.exec(command, { windowsHide: true, ...(options || {}) }, callback);
};
const spawn = (command, args, options) => {
  if (!Array.isArray(args)) { options = args; args = []; }
  return childProcess.spawn(command, args, { windowsHide: true, ...(options || {}) });
};

// Load secrets (e.g. SMTP credentials) from system/.env without overriding real env vars.
(function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8").split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) return;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  });
})();

// This is the brain of mariowOS when it is running in development mode.
// The backend owns the config file, login flow, desktop routes, and the app store.
// If you are building on top of the OS, this is the file to understand first.
const app = express();
const PORT = Number(process.env.MARIOWOS_PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('MARIOWOS_PORT must be a valid TCP port');
}
const currentOS = process.platform;
const SERVER_EXIT_CODES = Object.freeze({ SHUTDOWN: 20, UPDATE_RESTART: 21, KERNEL_REBOOT: 22 });
const BACKEND_INSTANCE_ID = process.env.MARIOWOS_BACKEND_INSTANCE_ID || null;
let httpServer = null;
let serverExitStarted = false;
const SOTA_REPOSITORY_URL = "https://github.com/mariowOS/SOTA.git";
const SOTA_VERSION_URL = process.env.MARIOWOS_SOTA_VERSION_URL ||
  "https://api.github.com/repos/mariowOS/SOTA/contents/version.json?ref=main";
const SOTA_COMPONENTS = new Set([
  "calculator", "explorer", "feedback", "help", "music", "notes", "settings",
  "store", "terminal", "desktop"
]);

function getRawGithubUrl(repoUrl) {
  // Store apps live on GitHub, and this helper turns a repo URL into a default icon URL.
  // It helps the app catalog show something meaningful even before a custom icon is uploaded.
  if (!repoUrl) return null;
  const cleanUrl = repoUrl.replace(/\.git$/, '');
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? `https://raw.githubusercontent.com/${match[1]}/main/icon.png` : null;
}

function exitAfterServerClose(exitCode) {
  if (serverExitStarted) return;
  serverExitStarted = true;

  if (!httpServer) {
    process.exit(exitCode);
    return;
  }

  const forceExitTimer = setTimeout(() => process.exit(exitCode), 1500);
  httpServer.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  });
  setTimeout(() => httpServer.closeAllConnections(), 250);
}

function hasValidShutdownToken(req) {
  const expected = process.env.MARIOWOS_SHUTDOWN_TOKEN;
  if (!expected) return false;

  const supplied = req.get('authorization') || '';
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
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
// This config object is the OS state file in a nutshell.
// It stores the current user, password hash, quick controls, and a few recovery flags.
// Everything that needs to survive a restart is written back into config.json here.
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
  auth: {
    user: process.env.MARIOWOS_SMTP_USER,
    pass: process.env.MARIOWOS_SMTP_PASSWORD
  },
  // Trust the OS certificate store too, so antivirus/proxy HTTPS inspection
  // (which re-signs TLS with a locally trusted root) doesn't break SMTP.
  tls: { ca: getTrustedCAs() }
});

function getTrustedCAs() {
  const tls = require("tls");
  if (typeof tls.getCACertificates !== "function") return undefined;
  try {
    return [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];
  } catch (e) {
    return undefined;
  }
}
const SMTP_CONFIGURED = Boolean(process.env.MARIOWOS_SMTP_USER && process.env.MARIOWOS_SMTP_PASSWORD);
if (!SMTP_CONFIGURED) console.warn("[mail] MARIOWOS_SMTP_USER / MARIOWOS_SMTP_PASSWORD not set: emails cannot be sent.");

function saveConfig() {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email.trim());
}

// One-time codes kept in memory, keyed by purpose + email. Codes are stored hashed.
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const pendingCodes = new Map();
const hashCode = code => crypto.createHash("sha256").update(String(code)).digest("hex");

// Email-client-safe template: tables + inline styles only (Gmail/Outlook strip <style> and flexbox).
function renderCodeEmail(purpose, code) {
  const isReset = purpose === "reset";
  const heading = isReset ? "Reset your password" : "Verify your email";
  const intro = isReset
    ? "Someone asked to reset the password of your mariowOS account. Use this code to choose a new one:"
    : "Welcome! Enter this code in <b>Settings &rsaquo; You</b> to confirm this email belongs to you:";
  const digits = code.split("").map(d =>
    `<td style="padding:0 4px;"><div style="width:44px;height:56px;line-height:56px;background:#ffffff;border:1px solid #e3e6ef;border-radius:12px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:700;color:#14161c;text-align:center;">${d}</div></td>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#eef1f7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your mariowOS code is ${code}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f7;padding:40px 16px;font-family:'Poppins','Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(20,22,28,0.08);">
        <tr><td style="background:linear-gradient(135deg,#0a84ff 0%,#5e5ce6 100%);background-color:#0a84ff;padding:36px 32px 32px;text-align:center;">
          <div style="font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">mariowOS</div>
          <div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,0.8);">${isReset ? "Account security" : "Account verification"}</div>
        </td></tr>
        <tr><td style="padding:36px 32px 8px;text-align:center;">
          <div style="font-size:22px;font-weight:600;color:#14161c;">${heading}</div>
          <div style="margin-top:12px;font-size:15px;line-height:1.6;color:#5b6070;">${intro}</div>
        </td></tr>
        <tr><td align="center" style="padding:24px 24px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="background:#f5f7fb;border-radius:18px;padding:18px 14px;"><tr>${digits}</tr></table>
        </td></tr>
        <tr><td style="padding:12px 32px 32px;text-align:center;">
          <div style="display:inline-block;padding:6px 14px;background:#fff4e5;border-radius:999px;font-size:12px;font-weight:600;color:#b25e00;">&#9201; Expires in 10 minutes</div>
        </td></tr>
        <tr><td style="padding:0 32px;"><div style="height:1px;background:#eceef3;"></div></td></tr>
        <tr><td style="padding:20px 32px 32px;text-align:center;font-size:12px;line-height:1.6;color:#8a8f9e;">
          Didn't request this? You can safely ignore this email &mdash; nothing will change.<br>
          Never share this code with anyone, not even the mariowOS team.
        </td></tr>
      </table>
      <div style="margin-top:20px;font-size:11px;color:#a0a5b3;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">&copy; ${new Date().getFullYear()} mariowOS &middot; Sent automatically, please don't reply.</div>
    </td></tr>
  </table>
</body></html>`;
}

async function sendCodeEmail(purpose, email) {
  if (!SMTP_CONFIGURED) return { ok: false, status: 503, error: "Email service not configured on this system." };
  const key = purpose + ":" + email.toLowerCase();
  const existing = pendingCodes.get(key);
  if (existing && Date.now() - existing.sentAt < CODE_COOLDOWN_MS) {
    const wait = Math.ceil((CODE_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
    return { ok: false, status: 429, error: `Please wait ${wait}s before requesting a new code.`, retryAfter: wait };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const title = purpose === "reset" ? "Password reset code" : "Email verification code";
  try {
    await transporter.sendMail({
      from: { name: "mariowOS", address: process.env.MARIOWOS_SMTP_USER },
      to: email,
      subject: `mariowOS - ${title}`,
      text: `Your mariowOS code is ${code}. It expires in 10 minutes.\nIf you did not request it, you can safely ignore this email.`,
      html: renderCodeEmail(purpose, code)
    });
  } catch (err) {
    const detail = [err.code, err.responseCode, err.message].filter(Boolean).join(" ");
    console.error("[mail] Failed to send code:", detail);
    try { fs.appendFileSync(path.join(__dirname, "mail-error.log"), `${new Date().toISOString()} ${detail}\n${err.stack || ""}\n`); } catch (e) {}
    return { ok: false, status: 502, error: "Could not send the email: " + detail };
  }
  pendingCodes.set(key, { hash: hashCode(code), expiresAt: Date.now() + CODE_TTL_MS, sentAt: Date.now(), attempts: 0 });
  return { ok: true };
}

function checkCode(purpose, email, code) {
  const key = purpose + ":" + String(email || "").trim().toLowerCase();
  const entry = pendingCodes.get(key);
  if (!entry) return { ok: false, error: "No code requested for this email. Request a new one." };
  if (Date.now() > entry.expiresAt) { pendingCodes.delete(key); return { ok: false, error: "Code expired. Request a new one." }; }
  if (entry.attempts >= CODE_MAX_ATTEMPTS) { pendingCodes.delete(key); return { ok: false, error: "Too many attempts. Request a new code." }; }
  entry.attempts++;
  const given = Buffer.from(hashCode(String(code || "").trim()));
  if (!crypto.timingSafeEqual(given, Buffer.from(entry.hash))) {
    return { ok: false, error: `Wrong code. ${CODE_MAX_ATTEMPTS - entry.attempts} attempts left.` };
  }
  pendingCodes.delete(key);
  return { ok: true };
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.get('/api/system/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', instanceId: BACKEND_INSTANCE_ID });
});

app.get('/api/system/boot-assets', (req, res) => {
  const bootModeFile = path.join(__dirname, 'boot-mode.json');
  const bootMode = fs.existsSync(bootModeFile)
    ? JSON.parse(fs.readFileSync(bootModeFile, 'utf8'))
    : { verbose: false };
  if (typeof bootMode.verbose !== 'boolean') throw new Error('Invalid verbose boot setting');

  const iconDirectory = path.join(__dirname, 'desktop', 'assets', 'icons');
  const icons = fs.readdirSync(iconDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(entry.name))
    .map(entry => `/desktop/assets/icons/${encodeURIComponent(entry.name)}`);
  const optionalAssets = [
    '/desktop/assets/wallpaper.factory.png',
    '/desktop/assets/wallpaper.user.png',
    '/desktop/assets/avatar.png',
    '/desktop/assets/avatar.user.png',
    '/desktop/assets/login.png',
    '/desktop/assets/next.png',
    '/desktop/assets/back.png'
  ];
  const customBootLogoPath = path.join(__dirname, 'desktop', 'assets', 'bootlogo.user.png');
  const bootLogo = fs.existsSync(customBootLogoPath)
    ? '/desktop/assets/bootlogo.user.png'
    : '/desktop/assets/icons/stars.png';

  res.set('Cache-Control', 'no-store');
  res.json({ requiredWallpaper: '/desktop/assets/wallpaper.factory.png', icons, optionalAssets, bootLogo, verbose: bootMode.verbose });
});

app.post('/api/system/shutdown', (req, res) => {
  if (process.env.MARIOWOS_MANAGED_BACKEND !== '1' || !hasValidShutdownToken(req)) {
    return res.status(403).json({ success: false, error: 'Shutdown is only available to the trusted Electron shell' });
  }

  res.status(202).json({ success: true });
  setTimeout(() => exitAfterServerClose(SERVER_EXIT_CODES.SHUTDOWN), 100);
});

app.post('/api/system/reboot', (req, res) => {
  if (process.env.MARIOWOS_MANAGED_BACKEND !== '1' || !hasValidShutdownToken(req)) {
    return res.status(403).json({ success: false, error: 'Kernel reboot is only available to the trusted Electron shell' });
  }

  res.status(202).json({ success: true });
  setTimeout(() => exitAfterServerClose(SERVER_EXIT_CODES.KERNEL_REBOOT), 100);
});

app.get('/boot', (req, res) => {
  res.sendFile(path.join(__dirname, 'boot.html'));
});

function serveUploadedImage(filePath, imageName) {
  return (req, res, next) => {
    let descriptor;
    let signature;
    try {
      descriptor = fs.openSync(filePath, 'r');
      signature = Buffer.alloc(8);
      fs.readSync(descriptor, signature, 0, signature.length, 0);
    } catch (error) {
      if (error.code === 'ENOENT') return next();
      return next(error);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    const isPng = signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    if (!isPng && !isJpeg) return res.status(415).send(`The saved ${imageName} is not a supported PNG or JPEG image.`);

    res.sendFile(filePath, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': isJpeg ? 'image/jpeg' : 'image/png'
      }
    }, error => {
      if (error) next(error);
    });
  };
}

app.get('/desktop/assets/avatar.user.png', serveUploadedImage(
  path.join(__dirname, 'desktop', 'assets', 'avatar.user.png'),
  'profile picture'
));

app.get('/desktop/assets/bootlogo.user.png', serveUploadedImage(
  path.join(__dirname, 'desktop', 'assets', 'bootlogo.user.png'),
  'boot logo'
));

// Static files are the actual desktop shell. The login screen, settings pages, and app folders
// are served as normal web assets from the filesystem, which keeps the OS feel web-based and easy to tweak.
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
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

const bootLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ["image/png", "image/jpeg"].includes(file.mimetype))
});

app.post("/api/system/set-volume", (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) return res.status(400).json({ success: false, error: "Missing volume" });

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
  if (!config.email || !config.verified || !SMTP_CONFIGURED) return;
  try {
    await transporter.sendMail({
      from: { name: "mariowOS", address: process.env.MARIOWOS_SMTP_USER },
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
// This is the Control Center layer. The desktop asks the backend what the system is doing
// with Wi‑Fi, Bluetooth, volume, Ethernet, and power mode, then renders that state to the user.
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
// These routes are the OS compatibility layer. mariowOS tries to detect what hardware is present
// on the host machine and then exposes a consistent Wi‑Fi/Bluetooth API to the desktop UI.
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
  if (!ssid) return res.status(400).json({ success: false, error: "Missing SSID" });

  let cmd = "";
  if (currentOS === "linux") {
    cmd = password ? `nmcli dev wifi connect "${ssid}" password "${password}"` : `nmcli dev wifi connect "${ssid}"`;
  } else if (currentOS === "win32") {
    cmd = `netsh wlan connect name="${ssid}"`;
  } else if (currentOS === "darwin") {
    cmd = password ? `networksetup -setairportnetwork en0 "${ssid}" "${password}"` : `networksetup -setairportnetwork en0 "${ssid}"`;
  }

  exec(cmd, (err) => {
    if (err) return res.status(500).json({ success: false, error: "Unable to connect to the network." });
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
  if (!target) return res.status(400).json({ success: false, error: "Missing target" });

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

// --- BACKUP & RESTORE ---
// This section protects user config and makes it easy to save and restore a machine state.
// In practice, it is one of the most important pieces for anyone building a custom mariowOS image.
const backupUpload = multer({ storage: multer.memoryStorage() });

app.get("/api/system/backup", (req, res) => {
  // Send current config, but explicitly remove the passwordHash for security
  const safeConfig = { ...config };
  delete safeConfig.passwordHash;
  res.json(safeConfig);
});

app.post("/api/system/restore", backupUpload.single("backupFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  
  try {
    const importedConfig = JSON.parse(req.file.buffer.toString());
    
    // Preserve the user's current password hash, don't overwrite it with the backup's missing one
    const currentPass = config.passwordHash;
    config = { ...importedConfig, passwordHash: currentPass };
    
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    res.json({ success: true, message: "Backup restored successfully" });
  } catch (e) {
    res.status(400).json({ success: false, error: "Invalid backup file format" });
  }
});

// --- RECOVERY & FRP ENGINE ---
// This is the safety net for the system. If a user loses access or the system is wiped,
// the recovery flow can lock the OS and allow a controlled reset or password re-entry.
app.use("/recovery", express.static(path.join(__dirname, "recovery")));

// 1. Intercept Boot for FRP Lock
// Update your root route ("/") to check for FRP first
app.get("/", (req, res) => {
  if (config.frpLock) {
    return res.sendFile(path.join(__dirname, "desktop/frp.html"));
  }
  res.sendFile(path.join(__dirname, !config.passwordHash ? "desktop/welcome.html" : "loginui/com.mariowos.loginui.html"));
});

// 2. Recovery Factory Reset (Triggers FRP)
app.post("/api/recovery/wipe", (req, res) => {
  const preservedHash = config.passwordHash;
  const allowFlashing = config.allowFlashing || false;
  
  // Wipe config but enable FRP and preserve the hash needed to unlock it
  config = {
    passwordHash: preservedHash,
    frpLock: true,
    allowFlashing: allowFlashing,
    quickSettings: { wifi: true, bluetooth: true, dnd: false, powerMode: "Balanced", isEthernet: false }
  };
  
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(__dirname, "keys.json"), JSON.stringify([]));
  res.json({ success: true });
});

// 3. FRP Verification Endpoint
app.post("/api/system/frp-unlock", async (req, res) => {
  const { type, payload } = req.body;
  
  if (type === "password") {
    const match = await bcrypt.compare(payload, config.passwordHash);
    if (match) {
      config.frpLock = false;
      config.passwordHash = null; // Cleared for fresh setup
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      return res.json({ success: true });
    }
    return res.json({ success: false, error: "Incorrect password." });
  } 
  else if (type === "file") {
    try {
      const importedConfig = typeof payload === 'string' ? JSON.parse(payload) : payload;
      config = { ...importedConfig, frpLock: false };
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      return res.json({ success: true });
    } catch (e) {
      return res.json({ success: false, error: "Invalid credentials file." });
    }
  }
});

// 4. Recovery Debug Terminal Endpoint
app.post("/api/recovery/debug", (req, res) => {
  if (!config.allowFlashing) {
    return res.status(403).json({ error: "locked", message: "Flashing/Debug is disabled in Functions Lab." });
  }
  
  exec(req.body.command, (err, stdout, stderr) => {
    res.json({ 
      success: !err, 
      output: stdout || stderr || (err ? err.message : "") 
    });
  });
});


// --- CORE ROUTES ---
// These are the main entry points for the interface: the app decides whether to show
// a welcome flow, a login, or the desktop based on whether a password is configured.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, !config.passwordHash ? "desktop/welcome.html" : "loginui/com.mariowos.loginui.html"));
});

// --- EMAIL VERIFICATION ---
app.post("/api/email/send-code", async (req, res) => {
  const email = String(req.body.email || config.email || "").trim();
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email address." });
  const result = await sendCodeEmail("verify", email);
  if (!result.ok) return res.status(result.status).json({ success: false, error: result.error, retryAfter: result.retryAfter });
  res.json({ success: true, message: "Code sent to " + email });
});

app.post("/api/email/verify-code", (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email address." });
  const result = checkCode("verify", email, req.body.code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  config.email = email;
  config.verified = true;
  saveConfig();
  res.json({ success: true, message: "Email verified!" });
});

// --- PASSWORD RECOVERY (uses the verified email) ---
app.post("/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email address." });
  if (!config.verified || !config.email || config.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(400).json({ success: false, error: "This email is not the verified email of this system." });
  }
  const result = await sendCodeEmail("reset", email);
  if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
  res.json({ success: true });
});

app.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (typeof newPassword !== "string" || newPassword.length < 4) {
    return res.status(400).json({ success: false, error: "Password must be at least 4 characters." });
  }
  const result = checkCode("reset", email, code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  config.passwordHash = await bcrypt.hash(newPassword, 10);
  saveConfig();
  res.json({ success: true });
});

// --- PREFERENCES (daily report email) ---
app.get("/api/preferences", (req, res) => {
  res.json({ sendReports: Boolean(config.sendReports), verified: Boolean(config.verified), email: config.email || "" });
});

app.post("/api/preferences", (req, res) => {
  const sendReports = Boolean(req.body.sendReports);
  if (sendReports && !config.verified) {
    return res.status(400).json({ success: false, error: "Verify your email in Settings first." });
  }
  config.sendReports = sendReports;
  saveConfig();
  scheduleDailyEmail();
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  if (!currentConfig.passwordHash) return res.status(409).send("No password is configured.");
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).send("Password is required.");
  }
  
  const match = await bcrypt.compare(password, currentConfig.passwordHash);
  if (!match) return res.status(401).send("Incorrect password.");
  res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
});

app.get("/get-settings", (req, res) => {
  const safe = { ...config };
  delete safe.passwordHash;
  res.json(safe);
});

app.post("/save-settings", (req, res) => {
  const { username, email, ...extra } = req.body;
  const PROTECTED = ["passwordHash", "verified", "quickSettings"];
  if (username !== undefined || email !== undefined) {
    const cleanName = String(username || "").trim();
    const cleanEmail = String(email || "").trim();
    if (!cleanName || cleanName.length > 50) return res.status(400).json({ success: false, error: "Username must be 1-50 characters." });
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ success: false, error: "Invalid email address." });
    if ((config.email || "").toLowerCase() !== cleanEmail.toLowerCase()) {
      config.verified = false;
      config.sendReports = false;
      scheduleDailyEmail();
    }
    config.username = cleanName;
    config.email = cleanEmail;
  }
  Object.keys(extra).forEach(key => {
    if (!PROTECTED.includes(key)) config[key] = extra[key];
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
  const { username, newPassword, currentPassword } = req.body;
  if (!newPassword || !username) return res.status(400).send("❌ Dati mancanti");
  if (config.passwordHash) {
    const ok = typeof currentPassword === "string" && await bcrypt.compare(currentPassword, config.passwordHash);
    if (!ok) return res.status(401).send("Current password is incorrect.");
  }
  config.username = username;
  config.passwordHash = await bcrypt.hash(newPassword, 10);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.send("Configurazione completata!");
});

app.post("/clear-password", async (req, res) => {
  if (config.passwordHash) {
    const { currentPassword } = req.body;
    const ok = typeof currentPassword === "string" && await bcrypt.compare(currentPassword, config.passwordHash);
    if (!ok) return res.status(401).send("Current password is incorrect.");
  }
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.send("Password cleared! You can now log in without a password.");
});


app.post("/api/system/factory-reset", (req, res) => {
  const errors = [];
  const removePath = target => {
    try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); }
    catch (e) { errors.push(path.basename(target) + ": " + e.message); }
  };

  // Apps installed from the store (folders, downloaded icons, tiles desktop)
  (config.installedApps || []).forEach(app => {
    if (isValidAppId(app.appId)) removePath(path.join(__dirname, "desktop", "apps", app.appId));
  });
  removePath(path.join(__dirname, "desktop", "com.mariowos.twm.html"));
  const assetsDir = path.join(__dirname, "desktop", "assets");
  try {
    fs.readdirSync(assetsDir)
      .filter(file => /^icon_.+\.png$/.test(file) || /\.user\.png$/.test(file))
      .forEach(file => removePath(path.join(assetsDir, file)));
  } catch (e) { errors.push("assets: " + e.message); }

  config = {
    passwordHash: null,
    rules: [],
    rulesEnabled: true,
    quickSettings: { wifi: true, bluetooth: true, dnd: false, powerMode: "Balanced", isEthernet: false }
  };
  saveConfig();
  fs.writeFileSync(path.join(__dirname, "keys.json"), JSON.stringify([]));
  Object.keys(ruleLastRun).forEach(id => delete ruleLastRun[id]);
  Object.keys(batteryRuleState).forEach(id => delete batteryRuleState[id]);
  startupRulesRun.clear();
  pendingRuleNotifications.length = 0;
  pendingCodes.clear();
  scheduleDailyEmail();

  if (errors.length) console.error("Factory reset warnings:", errors);
  res.json({ success: true, message: "Factory Reset Completato", warnings: errors });
});

app.post("/upload-wallpaper", wallpaperUpload.single("wallpaper"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  res.json({ success: true, message: "Wallpaper uploaded!" });
});

app.post('/api/system/boot-logo', (req, res, next) => {
  bootLogoUpload.single('bootLogo')(req, res, error => {
    if (error) {
      if (error instanceof multer.MulterError) {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ success: false, error: error.message });
      }
      return next(error);
    }

    if (!req.file) return res.status(400).json({ success: false, error: 'Choose a PNG or JPEG image' });

    const signature = req.file.buffer.subarray(0, 8);
    const isPng = signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    if (!isPng && !isJpeg) return res.status(415).json({ success: false, error: 'The selected file is not a valid PNG or JPEG image' });

    const bootLogoPath = path.join(__dirname, 'desktop', 'assets', 'bootlogo.user.png');
    fs.writeFile(bootLogoPath, req.file.buffer, writeError => {
      if (writeError) return next(writeError);
      res.json({ success: true, message: 'Boot logo saved. It will appear the next time mariowOS starts.' });
    });
  });
});

app.delete('/api/system/boot-logo', (req, res, next) => {
  const bootLogoPath = path.join(__dirname, 'desktop', 'assets', 'bootlogo.user.png');
  fs.unlink(bootLogoPath, error => {
    if (error && error.code !== 'ENOENT') return next(error);
    res.json({ success: true, message: 'Default boot logo restored.' });
  });
});

app.post("/api/system/reset-settings", (req, res) => {
  config.sendReports = false;
  config.email = "";
  config.verified = false;
  ["darkMode", "performance", "animations", "developer", "allowFlashing"].forEach(key => delete config[key]);
  saveConfig();
  scheduleDailyEmail();
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

// The app store is the public software layer of mariowOS.
// It blends a remote catalog with local packages so the desktop can stay fresh without
// losing custom apps that are built specifically for a branch or device.
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
  // This is the installation pipeline used by the app store.
  // It accepts GitHub repos or direct file URLs, downloads the app bundle, and registers
  // it inside the desktop shell so it behaves like a native mariowOS app.
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

if (!Array.isArray(config.rules)) config.rules = [];
if (typeof config.rulesEnabled !== "boolean") config.rulesEnabled = true;
const ruleLastRun = {};
const batteryRuleState = {};
const startupRulesRun = new Set();
const pendingRuleNotifications = [];

// --- CALENDAR ---
// Events use "floating" local time (date YYYY-MM-DD, time HH:MM) like the system clock does.
// .ics import/export makes them interoperable with Windows Calendar, Outlook, Google, Apple.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAL_COLORS = ["blue", "green", "red", "orange", "purple", "pink", "teal"];
if (!Array.isArray(config.calendarEvents)) config.calendarEvents = [];

function cleanEvent(input, existing = {}) {
  const ev = { ...existing };
  if (input.title !== undefined) ev.title = String(input.title).trim().slice(0, 120);
  if (input.notes !== undefined) ev.notes = String(input.notes).slice(0, 2000);
  if (input.location !== undefined) ev.location = String(input.location).trim().slice(0, 200);
  if (input.date !== undefined) ev.date = String(input.date);
  if (input.endDate !== undefined) ev.endDate = input.endDate ? String(input.endDate) : "";
  if (input.allDay !== undefined) ev.allDay = Boolean(input.allDay);
  if (input.start !== undefined) ev.start = input.start ? String(input.start) : "";
  if (input.end !== undefined) ev.end = input.end ? String(input.end) : "";
  if (input.color !== undefined) ev.color = CAL_COLORS.includes(input.color) ? input.color : "blue";
  if (input.reminder !== undefined) {
    const r = Number(input.reminder);
    ev.reminder = Number.isFinite(r) && r >= 0 && r <= 10080 ? Math.round(r) : -1; // minutes before, -1 = none
  }
  if (input.repeat !== undefined) ev.repeat = ["none", "daily", "weekly", "monthly", "yearly"].includes(input.repeat) ? input.repeat : "none";

  if (!ev.title) return { error: "Title is required." };
  if (!DATE_RE.test(ev.date || "")) return { error: "Invalid date." };
  if (ev.endDate && (!DATE_RE.test(ev.endDate) || ev.endDate < ev.date)) return { error: "End date must be after the start date." };
  if (!ev.allDay) {
    if (!TIME_RE.test(ev.start || "")) return { error: "Invalid start time." };
    if (ev.end && !TIME_RE.test(ev.end)) return { error: "Invalid end time." };
    if (ev.end && (!ev.endDate || ev.endDate === ev.date) && ev.end < ev.start) return { error: "End time must be after the start time." };
  } else {
    ev.start = ""; ev.end = "";
  }
  ev.color = ev.color || "blue";
  ev.repeat = ev.repeat || "none";
  if (ev.reminder === undefined) ev.reminder = ev.allDay ? -1 : 10;
  return { event: ev };
}

app.get("/api/calendar/events", (req, res) => res.json(config.calendarEvents));

app.post("/api/calendar/events", (req, res) => {
  const { event, error } = cleanEvent(req.body || {});
  if (error) return res.status(400).json({ success: false, error });
  event.id = crypto.randomUUID();
  event.created = new Date().toISOString();
  config.calendarEvents.push(event);
  saveConfig();
  res.json({ success: true, event });
});

app.put("/api/calendar/events/:id", (req, res) => {
  const index = config.calendarEvents.findIndex(e => e.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, error: "Event not found." });
  const { event, error } = cleanEvent(req.body || {}, config.calendarEvents[index]);
  if (error) return res.status(400).json({ success: false, error });
  config.calendarEvents[index] = event;
  saveConfig();
  res.json({ success: true, event });
});

app.delete("/api/calendar/events/:id", (req, res) => {
  const before = config.calendarEvents.length;
  config.calendarEvents = config.calendarEvents.filter(e => e.id !== req.params.id);
  if (config.calendarEvents.length === before) return res.status(404).json({ success: false, error: "Event not found." });
  saveConfig();
  res.json({ success: true });
});

// iCalendar (RFC 5545) helpers
const icsEscape = s => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const icsUnescape = s => String(s || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const compactDate = d => d.replace(/-/g, "");
const addDays = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

app.get("/api/calendar/export.ics", (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mariowOS//Calendar//EN", "CALSCALE:GREGORIAN"];
  for (const ev of config.calendarEvents) {
    lines.push("BEGIN:VEVENT", `UID:${ev.uid || ev.id + "@mariowos"}`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(ev.title)}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(ev.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(ev.endDate || ev.date, 1))}`);
    } else {
      lines.push(`DTSTART:${compactDate(ev.date)}T${ev.start.replace(":", "")}00`);
      if (ev.end) lines.push(`DTEND:${compactDate(ev.endDate || ev.date)}T${ev.end.replace(":", "")}00`);
    }
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
    if (ev.repeat && ev.repeat !== "none") lines.push(`RRULE:FREQ=${ev.repeat.toUpperCase()}`);
    if (ev.reminder >= 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${ev.reminder}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="mariowOS-calendar.ics"');
  res.send(lines.join("\r\n"));
});

app.post("/api/calendar/import", express.text({ type: "*/*", limit: "5mb" }), (req, res) => {
  const text = typeof req.body === "string" ? req.body : "";
  if (!text.includes("BEGIN:VCALENDAR")) return res.status(400).json({ success: false, error: "This is not a valid .ics calendar file." });
  const unfolded = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const parseDT = (value, params) => {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    if (!m[4] || /VALUE=DATE/i.test(params)) return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
    if (m[7]) { // UTC -> local system time
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
      const pad = n => String(n).padStart(2, "0");
      return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, allDay: false };
    }
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
  };
  let current = null, inAlarm = false, imported = 0, skipped = 0;
  const existingUids = new Set(config.calendarEvents.map(e => e.uid).filter(Boolean));
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const [name, ...paramParts] = line.slice(0, idx).split(";");
    const params = paramParts.join(";");
    const value = line.slice(idx + 1);
    const key = name.toUpperCase();
    if (key === "BEGIN" && value === "VEVENT") { current = {}; continue; }
    if (key === "BEGIN" && value === "VALARM") { inAlarm = true; continue; }
    if (key === "END" && value === "VALARM") { inAlarm = false; continue; }
    if (!current) continue;
    if (inAlarm) {
      const t = key === "TRIGGER" && value.match(/^-P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
      if (t) current.reminder = (+(t[1] || 0)) * 1440 + (+(t[2] || 0)) * 60 + (+(t[3] || 0));
      continue;
    }
    if (key === "SUMMARY") current.title = icsUnescape(value);
    else if (key === "DESCRIPTION") current.notes = icsUnescape(value);
    else if (key === "LOCATION") current.location = icsUnescape(value);
    else if (key === "UID") current.uid = value;
    else if (key === "DTSTART") current.dtstart = parseDT(value, params);
    else if (key === "DTEND") current.dtend = parseDT(value, params);
    else if (key === "RRULE") { const f = value.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i); if (f) current.repeat = f[1].toLowerCase(); }
    else if (key === "END" && value === "VEVENT") {
      const c = current; current = null;
      if (!c.dtstart || (c.uid && existingUids.has(c.uid))) { skipped++; continue; }
      const input = { title: c.title || "(No title)", notes: c.notes || "", location: c.location || "", date: c.dtstart.date, allDay: c.dtstart.allDay, repeat: c.repeat || "none" };
      if (!c.dtstart.allDay) {
        input.start = c.dtstart.time;
        if (c.dtend && !c.dtend.allDay) { input.end = c.dtend.time; if (c.dtend.date !== c.dtstart.date) input.endDate = c.dtend.date; }
      } else if (c.dtend && c.dtend.allDay) {
        const last = addDays(c.dtend.date, -1);
        if (last > c.dtstart.date) input.endDate = last;
      }
      if (c.reminder !== undefined) input.reminder = c.reminder;
      const { event } = cleanEvent(input);
      if (!event) { skipped++; continue; }
      event.id = crypto.randomUUID();
      event.created = new Date().toISOString();
      if (c.uid) { event.uid = c.uid; existingUids.add(c.uid); }
      config.calendarEvents.push(event);
      imported++;
    }
  }
  saveConfig();
  res.json({ success: true, imported, skipped });
});

app.get("/api/rules", (req, res) => { res.json(Array.isArray(config.rules) ? config.rules : []); });
app.get("/api/rules/enabled", (req, res) => { res.json({ enabled: config.rulesEnabled !== false }); });

app.post("/api/rules/enabled", (req, res) => {
  if (typeof req.body.enabled !== "boolean") return res.status(400).json({ success: false, error: "enabled must be a boolean" });
  config.rulesEnabled = req.body.enabled;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, enabled: config.rulesEnabled });
});

app.post("/api/rules/save", (req, res) => {
  if (!Array.isArray(req.body.rules)) return res.status(400).json({ success: false, error: "rules must be an array" });
  const ids = new Set(req.body.rules.map(r => r.id));
  Object.keys(ruleLastRun).forEach(id => { if (!ids.has(Number(id))) delete ruleLastRun[id]; });
  Object.keys(batteryRuleState).forEach(id => { if (!ids.has(Number(id))) delete batteryRuleState[id]; });
  startupRulesRun.forEach(id => { if (!ids.has(id)) startupRulesRun.delete(id); });
  config.rules = req.body.rules;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

app.post("/api/rules/trigger", (req, res) => {
  const ruleId = Number(req.body.id);
  const rule = config.rules.find(item => Number(item.id) === ruleId);
  if (!rule) return res.status(404).json({ success: false, error: "Rule not found" });
  if (config.rulesEnabled === false || !rule.enabled) return res.json({ success: true, fired: false, retry: true });

  if (req.body.trigger === "battery" && rule.trigger === "battery" && rule.action === "notify") {
    const level = Number(req.body.level);
    const threshold = Number(rule.triggerValue);
    if (!Number.isFinite(level) || level < 0 || level > 100 || !Number.isFinite(threshold)) {
      return res.status(400).json({ success: false, error: "Invalid battery level" });
    }
    const isBelowThreshold = level <= threshold;
    const wasBelowThreshold = batteryRuleState[ruleId] === true;
    batteryRuleState[ruleId] = isBelowThreshold;
    if (isBelowThreshold && !wasBelowThreshold) executeRuleAction(rule.action, rule.actionParams);
    return res.json({ success: true, fired: isBelowThreshold && !wasBelowThreshold });
  }

  if (req.body.trigger === "startup" && rule.trigger === "startup" && rule.action === "launch-app") {
    if (startupRulesRun.has(ruleId)) return res.json({ success: true, fired: false, retry: false });
    const appId = rule.actionParams && rule.actionParams.appId;
    const appIsInstalled = (config.installedApps || []).some(app => app.appId === appId);
    if (!appIsInstalled) return res.status(400).json({ success: false, error: "Startup app is not installed" });
    startupRulesRun.add(ruleId);
    return res.json({ success: true, fired: true, appId });
  }

  res.status(400).json({ success: false, error: "Trigger does not match this rule" });
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
    case 'shutdown': {
      const command = currentOS === 'win32' ? 'shutdown.exe' : 'shutdown';
      const args = currentOS === 'win32'
        ? ['/s', '/t', '60', '/c', 'Scheduled by a mariowOS rule']
        : ['-h', '+1'];
      const shutdownProcess = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      shutdownProcess.on('error', error => console.error('Rule shutdown error:', error.message));
      shutdownProcess.unref();
      pendingRuleNotifications.push({
        title: 'Shutdown scheduled',
        msg: 'This computer will shut down in one minute. Cancel it with the system shutdown cancel command.',
        icon: 'power_settings_new'
      });
      break;
    }
  }
}

setInterval(() => {
  if (config.rulesEnabled === false) return;
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const now = new Date();
  const currentHour = now.getHours(), currentMin = now.getMinutes();
  const today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();

  rules.forEach(rule => {
    if (!rule || !rule.enabled) return;
    if (rule.trigger === 'time' && /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.triggerValue || '')) {
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
let systemUpdateInProgress = false;

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git exited with code ${code}`));
    });
  });
}

function validateStagedServer(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", filePath], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Staged server.js failed its syntax check"));
    });
  });
}

function matchesGitBlob(contents, expectedHash) {
  const hashBuffer = buffer => crypto.createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
  if (hashBuffer(contents) === expectedHash) return true;

  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents) || !text.includes("\r\n")) return false;
  return hashBuffer(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")) === expectedHash;
}

function getStagedUpdateFiles(stagePath) {
  const index = runGit(["-C", stagePath, "ls-files", "-s", "-z"], stagePath);
  return index.then(output => {
    const entries = output.split("\0").filter(Boolean).map(record => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("Invalid Git file index entry");
      const [mode, blobHash, stage] = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1).replace(/\\/g, "/");
      const normalizedPath = path.posix.normalize(relativePath);
      if (!relativePath || normalizedPath.startsWith("../") || normalizedPath.startsWith("/") || normalizedPath !== relativePath) {
        throw new Error(`Unsafe update path: ${relativePath}`);
      }
      if (relativePath.split("/").some(segment =>
        /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
      )) {
        throw new Error(`Update path is not supported on this system: ${relativePath}`);
      }
      if (!["100644", "100755"].includes(mode) || stage !== "0") {
        throw new Error(`Unsupported update file type: ${relativePath}`);
      }
      const targetPath = path.resolve(__dirname, ...relativePath.split("/"));
      if (targetPath !== __dirname && !targetPath.startsWith(`${__dirname}${path.sep}`)) {
        throw new Error(`Update path escapes the installation: ${relativePath}`);
      }
      return { relativePath, blobHash, mode };
    });

    for (const entry of entries) {
      if (path.posix.basename(entry.relativePath).toLowerCase() === "config.json" ||
          entry.relativePath.toLowerCase() === "sota-installed.json") continue;
      const stagedFile = path.join(stagePath, ...entry.relativePath.split("/"));
      const fileStat = fs.lstatSync(stagedFile);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Update entry is not a regular file: ${entry.relativePath}`);
      }
      const contents = fs.readFileSync(stagedFile);
      if (!matchesGitBlob(contents, entry.blobHash)) {
        throw new Error(`Integrity check failed: ${entry.relativePath}`);
      }
      entry.stagedFile = stagedFile;
      entry.size = contents.length;
    }

    return entries.filter(entry => entry.stagedFile);
  });
}

function validateSotaManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("SOTA version.json must be a flat component-to-version map");
  }
  const names = Object.keys(manifest);
  if (names.length !== SOTA_COMPONENTS.size ||
      names.some(name => !SOTA_COMPONENTS.has(name))) {
    throw new Error("SOTA version.json must include exactly the supported app names and desktop");
  }
  for (const name of SOTA_COMPONENTS) {
    if (typeof manifest[name] !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest[name])) {
      throw new Error(`Invalid SOTA version for ${name}`);
    }
  }
  return manifest;
}

function readInstalledSotaVersions() {
  const installedPath = path.join(__dirname, "sota-installed.json");
  return validateSotaManifest(JSON.parse(fs.readFileSync(installedPath, "utf8")));
}

async function fetchSotaManifest() {
  const response = await fetch(SOTA_VERSION_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      "User-Agent": "mariowOS-SOTA-Updater"
    },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`SOTA manifest request failed (${response.status})`);
  const payload = await response.json();
  if (payload && payload.encoding === "base64" && typeof payload.content === "string") {
    const contents = Buffer.from(payload.content.replace(/\s/g, ""), "base64");
    const blobHash = crypto.createHash("sha1")
      .update(`blob ${contents.length}\0`)
      .update(contents)
      .digest("hex");
    if (typeof payload.sha !== "string" || payload.sha !== blobHash) {
      throw new Error("SOTA manifest integrity check failed");
    }
    return validateSotaManifest(JSON.parse(contents.toString("utf8")));
  }
  return validateSotaManifest(payload);
}

function getStagedSotaFiles(stagePath) {
  return runGit(["-C", stagePath, "ls-files", "-s", "-z"], stagePath).then(output => {
    const targetPaths = new Set();
    const entries = output.split("\0").filter(Boolean).map(record => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("Invalid SOTA Git file index entry");
      const [mode, blobHash, stage] = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1).replace(/\\/g, "/");
      const normalizedPath = path.posix.normalize(relativePath);
      if (!relativePath || normalizedPath.startsWith("../") ||
          normalizedPath.startsWith("/") || normalizedPath !== relativePath) {
        throw new Error(`Unsafe SOTA path: ${relativePath}`);
      }
      if (relativePath.split("/").some(segment =>
        /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
      )) {
        throw new Error(`SOTA path is not supported on this system: ${relativePath}`);
      }
      if (!["100644", "100755"].includes(mode) || stage !== "0") {
        throw new Error(`Unsupported SOTA file type: ${relativePath}`);
      }

      if (relativePath === "version.json" || relativePath === "README.md" ||
          relativePath === "LICENSE" || relativePath === "LICENSE.txt") {
        if (relativePath === "version.json") {
          if (mode !== "100644" || stage !== "0") throw new Error("Invalid SOTA version.json index entry");
          const manifestFile = path.join(stagePath, "version.json");
          const stat = fs.lstatSync(manifestFile);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SOTA version.json must be a regular file");
          const contents = fs.readFileSync(manifestFile);
          if (!matchesGitBlob(contents, blobHash)) {
            throw new Error("SOTA version.json integrity check failed");
          }
          validateSotaManifest(JSON.parse(contents.toString("utf8")));
        }
        return null;
      }

      const segments = relativePath.split("/");
      const component = segments[0];
      const packagePath = segments.slice(1).join("/");
      if (!SOTA_COMPONENTS.has(component) || !packagePath) {
        throw new Error(`Unexpected file in SOTA repository: ${relativePath}`);
      }
      const normalizedPackagePath = packagePath.toLowerCase();
      if (component === "desktop" &&
          (normalizedPackagePath === "apps" || normalizedPackagePath.startsWith("apps/") ||
           normalizedPackagePath === "fallback/apps/feedback" ||
           normalizedPackagePath.startsWith("fallback/apps/feedback/"))) {
        throw new Error(`Desktop SOTA payload overlaps an app package: ${relativePath}`);
      }

      const targetRelativePath = component === "desktop"
        ? `desktop/${packagePath}`
        : component === "feedback"
          ? `desktop/fallback/apps/feedback/${packagePath}`
          : `desktop/apps/${component}/${packagePath}`;
      const targetPath = path.resolve(__dirname, ...targetRelativePath.split("/"));
      if (!targetPath.startsWith(`${path.join(__dirname, "desktop")}${path.sep}`)) {
        throw new Error(`SOTA path escapes the desktop installation: ${relativePath}`);
      }
      const targetKey = targetRelativePath.toLowerCase();
      if (targetPaths.has(targetKey)) throw new Error(`Duplicate SOTA target path: ${relativePath}`);
      targetPaths.add(targetKey);
      return { relativePath: targetRelativePath, sourcePath: relativePath, blobHash, mode };
    }).filter(Boolean);

    for (const entry of entries) {
      if (path.posix.basename(entry.sourcePath).toLowerCase() === "config.json") continue;
      const stagedFile = path.join(stagePath, ...entry.sourcePath.split("/"));
      const stat = fs.lstatSync(stagedFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`SOTA entry is not a regular file: ${entry.sourcePath}`);
      }
      const contents = fs.readFileSync(stagedFile);
      if (!matchesGitBlob(contents, entry.blobHash)) {
        throw new Error(`SOTA integrity check failed: ${entry.sourcePath}`);
      }
      entry.stagedFile = stagedFile;
    }
    return entries.filter(entry => entry.stagedFile &&
      path.posix.basename(entry.sourcePath).toLowerCase() !== "config.json");
  });
}

function ensureSafeUpdateParent(relativePath, createdDirectories) {
  const segments = relativePath.split("/");
  segments.pop();
  let currentPath = __dirname;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (fs.existsSync(currentPath)) {
      const stat = fs.lstatSync(currentPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe update directory: ${segment}`);
      }
    } else {
      fs.mkdirSync(currentPath);
      createdDirectories.push(currentPath);
    }
  }
}

function applyStagedFiles(files, send, initialPercent, finalPercent) {
  const applied = [];
  const createdDirectories = [];
  const regularFiles = files.filter(file => file.relativePath !== "server.js");

  const rollback = () => {
    for (const file of applied.reverse()) {
      if (fs.existsSync(file.targetPath)) fs.rmSync(file.targetPath, { force: true });
      if (file.hadOriginal && fs.existsSync(file.backupPath)) fs.renameSync(file.backupPath, file.targetPath);
    }
    for (const directory of createdDirectories.reverse()) {
      try { fs.rmdirSync(directory); } catch (cleanupError) {
        if (cleanupError.code !== "ENOTEMPTY") throw cleanupError;
      }
    }
  };

  try {
    regularFiles.forEach((file, index) => {
      ensureSafeUpdateParent(file.relativePath, createdDirectories);
      const targetPath = path.join(__dirname, ...file.relativePath.split("/"));
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        throw new Error(`Update file conflicts with a directory: ${file.relativePath}`);
      }

      const token = `${process.pid}-${Date.now()}-${index}`;
      const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${token}.update`);
      const backupPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${token}.backup`);
      fs.copyFileSync(file.stagedFile, temporaryPath);
      if (process.platform !== "win32") fs.chmodSync(temporaryPath, file.mode === "100755" ? 0o755 : 0o644);
      const hadOriginal = fs.existsSync(targetPath);
      try {
        if (hadOriginal) fs.renameSync(targetPath, backupPath);
        fs.renameSync(temporaryPath, targetPath);
      } catch (error) {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        if (hadOriginal && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
        throw error;
      }
      applied.push({ targetPath, backupPath, hadOriginal });
      if (regularFiles.length) {
        const percent = initialPercent + ((index + 1) / regularFiles.length) * (finalPercent - initialPercent);
        send(Math.floor(percent), `Installing files (${index + 1}/${regularFiles.length})...`);
      }
    });
  } catch (error) {
    rollback();
    throw error;
  }

  return {
    commit() {
      for (const file of applied) {
        if (file.hadOriginal && fs.existsSync(file.backupPath)) {
          try { fs.rmSync(file.backupPath, { force: true }); }
          catch (error) { console.error(`Could not remove update backup ${file.backupPath}:`, error); }
        }
      }
    },
    rollback
  };
}

function launchServerReplacement(stagePath, serverMode) {
  const stagedServer = path.join(stagePath, "server.js");
  const helper = `
    const fs = require("fs");
    const path = require("path");
    const { spawn } = require("child_process");
    const [root, stagedFile, parentPid, stage, mode] = process.argv.slice(1);
    const target = path.join(root, "server.js");
    const backup = path.join(root, ".server.js.update-backup");
    const temporary = path.join(root, ".server.js.update-temp");
    const updateMarker = process.env.MARIOWOS_UPDATE_MARKER;
    const writeUpdateResult = result => {
      if (!updateMarker) return;
      const markerTemp = updateMarker + ".tmp";
      fs.writeFileSync(markerTemp, JSON.stringify(result));
      fs.renameSync(markerTemp, updateMarker);
    };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      let parentExited = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        try { process.kill(Number(parentPid), 0); await delay(100); }
        catch (error) { if (error.code === "ESRCH") { parentExited = true; break; } throw error; }
      }
      if (!parentExited) throw new Error("Timed out waiting for the old server to stop");
      fs.copyFileSync(stagedFile, temporary);
      if (process.platform !== "win32") fs.chmodSync(temporary, Number(mode) === 0o755 ? 0o755 : 0o644);
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      try { fs.renameSync(temporary, target); }
      catch (error) {
        if (fs.existsSync(backup)) fs.renameSync(backup, target);
        throw error;
      }
      if (process.env.MARIOWOS_MANAGED_BACKEND !== "1") {
        const backend = spawn(process.execPath, [target], {
          cwd: root, detached: true, stdio: "ignore", windowsHide: true
        });
        await new Promise((resolve, reject) => {
          backend.once("spawn", resolve);
          backend.once("error", reject);
        });
        backend.unref();
      }
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.rmSync(stage, { recursive: true, force: true });
      writeUpdateResult({ success: true });
    })().catch(error => {
      let restoreError = null;
      try {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
        if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
      } catch (failure) { restoreError = failure; }
      const details = error.stack + "\\n" + (restoreError ? "Restore failed: " + restoreError.stack + "\\n" : "");
      try {
        fs.appendFileSync(path.join(root, "update-error.log"), details);
        writeUpdateResult({ success: false, error: error.message });
      } catch (reportError) {
        fs.appendFileSync(path.join(root, "update-error.log"), reportError.stack + "\\n");
      }
      process.exitCode = 1;
    });
  `;
  const helperProcess = spawn(process.execPath, ["-e", helper, __dirname, stagedServer, String(process.pid), stagePath, serverMode], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  helperProcess.unref();
  return new Promise((resolve, reject) => {
    helperProcess.once("spawn", resolve);
    helperProcess.once("error", reject);
  });
}

// --- ABOUT / BUILD INFO ---
// The build date is the newest modification time of the OS's own files, so the
// About page reports when the system was really last changed instead of a date
// somebody has to remember to edit by hand.
const BUILD_ROOTS = ["server.js", "launcher.js", "preload.js", "boot.html", "desktop", "loginui", "recovery"];
const BUILD_SKIP_NAMES = new Set(["node_modules", "config.json", "keys.json", "sota-installed.json", "mail-error.log", ".env"]);
const BUILD_CACHE_MS = 60 * 1000;
let buildDateCache = { value: 0, computedAt: 0 };

function newestModifiedTime(target, skipDirs, depth = 0) {
  let stats;
  try { stats = fs.statSync(target); } catch (e) { return 0; }
  if (stats.isFile()) return stats.mtimeMs;
  if (!stats.isDirectory() || depth > 6) return 0;
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (e) { return 0; }
  let newest = 0;
  for (const entry of entries) {
    if (BUILD_SKIP_NAMES.has(entry.name) || /\.user\.(png|jpe?g)$/i.test(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory() && skipDirs.has(full)) continue;
    newest = Math.max(newest, newestModifiedTime(full, skipDirs, depth + 1));
  }
  return newest;
}

function getBuildDate() {
  if (Date.now() - buildDateCache.computedAt < BUILD_CACHE_MS && buildDateCache.value) return buildDateCache.value;
  // Apps the user installed from the Store aren't part of the system build.
  const skipDirs = new Set((config.installedApps || [])
    .filter(app => isValidAppId(app.appId))
    .map(app => path.join(__dirname, "desktop", "apps", app.appId)));
  let newest = 0;
  for (const entry of BUILD_ROOTS) newest = Math.max(newest, newestModifiedTime(path.join(__dirname, entry), skipDirs));
  buildDateCache = { value: newest || Date.now(), computedAt: Date.now() };
  return buildDateCache.value;
}

app.get("/api/system/about", (req, res) => {
  let version = "1.0.0";
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")).version || version; } catch (e) {}
  res.set("Cache-Control", "no-store");
  res.json({ version, buildDate: new Date(getBuildDate()).toISOString() });
});

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
  if (systemUpdateInProgress) {
    return res.status(409).json({ success: false, error: "updater is busy" });
  }
  systemUpdateInProgress = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (percent, status, finished = false) => {
    const msg = `data: ${JSON.stringify({ percent, status, finished })}\n\n`;
    try { res.write(msg); } catch (e) {}
  };

  const stagePath = path.join(os.tmpdir(), `mariowos-update-${process.pid}-${Date.now()}`);
  send(0, "Preparing update...");
  (async () => {
    try {
      send(5, "Downloading complete update...");
      await runGit(["clone", "--quiet", "--depth", "1", "--branch", "main", "https://github.com/mariowOS/stable.git", stagePath], os.tmpdir());
      send(70, "Checking every downloaded file...");
      const files = await getStagedUpdateFiles(stagePath);
      if (files.length === 0) throw new Error("The update contains no files");
      const serverUpdate = files.find(file => file.relativePath === "server.js");
      if (serverUpdate) await validateStagedServer(serverUpdate.stagedFile);
      send(75, `Verified ${files.length} files. Applying update...`);
      const transaction = applyStagedFiles(files, send, 75, 98);

      if (serverUpdate) {
        try {
          await launchServerReplacement(stagePath, serverUpdate.mode);
          transaction.commit();
        } catch (error) {
          transaction.rollback();
          throw error;
        }
        send(100, "Update complete. Replacing server and restarting...", true);
        res.end();
        setTimeout(() => process.exit(SERVER_EXIT_CODES.UPDATE_RESTART), 300);
      } else {
        transaction.commit();
        fs.rmSync(stagePath, { recursive: true, force: true });
        send(100, "Update complete. No server restart is required.", true);
        res.end();
        systemUpdateInProgress = false;
      }
    } catch (error) {
      try { fs.rmSync(stagePath, { recursive: true, force: true }); }
      catch (cleanupError) { console.error("Could not clean staged system update:", cleanupError); }
      console.error("System update failed:", error);
      send(0, `Update failed: ${error.message}`, true);
      res.end();
      systemUpdateInProgress = false;
    }
  })();
});

app.get("/api/system/check-sota-update", async (req, res) => {
  try {
    const current = readInstalledSotaVersions();
    const latest = await fetchSotaManifest();
    const updates = [...SOTA_COMPONENTS]
      .filter(name => latest[name] !== current[name])
      .map(name => ({ name, current: current[name], latest: latest[name] }));
    res.json({ success: true, updateAvailable: updates.length > 0, updates });
  } catch (error) {
    console.error("SOTA update check failed:", error);
    res.status(502).json({ success: false, updateAvailable: false, error: error.message });
  }
});

app.get("/api/system/sota-update", (req, res) => {
  if (systemUpdateInProgress) {
    return res.status(409).json({ success: false, error: "Another system update is already in progress" });
  }
  systemUpdateInProgress = true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const send = (percent, status, finished = false) => {
    try { res.write(`data: ${JSON.stringify({ percent, status, finished })}\n\n`); }
    catch (error) { console.error("Could not send SOTA update progress:", error); }
  };
  const stagePath = path.join(os.tmpdir(), `mariowos-sota-${process.pid}-${Date.now()}`);
  send(0, "Preparing component update...");

  (async () => {
    try {
      send(5, "Downloading SOTA packages...");
      await runGit(["clone", "--quiet", "--depth", "1", "--branch", "main", SOTA_REPOSITORY_URL, stagePath], os.tmpdir());
      send(35, "Verifying SOTA packages...");
      const allFiles = await getStagedSotaFiles(stagePath);
      const latest = JSON.parse(fs.readFileSync(path.join(stagePath, "version.json"), "utf8"));
      validateSotaManifest(latest);
      const current = readInstalledSotaVersions();
      const changedComponents = [...SOTA_COMPONENTS].filter(name => latest[name] !== current[name]);

      if (changedComponents.length === 0) {
        fs.rmSync(stagePath, { recursive: true, force: true });
        send(100, "All system components are up to date.", true);
        res.end();
        systemUpdateInProgress = false;
        return;
      }

      const changedSet = new Set(changedComponents);
      const packageFiles = allFiles.filter(file => changedSet.has(file.sourcePath.split("/")[0]));
      for (const component of changedComponents) {
        if (!packageFiles.some(file => file.sourcePath.startsWith(`${component}/`))) {
          throw new Error(`SOTA package "${component}" has a new version but contains no files`);
        }
      }

      const nextVersions = { ...current };
      for (const component of changedComponents) nextVersions[component] = latest[component];
      const statePath = path.join(stagePath, ".sota-installed-state");
      fs.writeFileSync(statePath, `${JSON.stringify(nextVersions, null, 2)}\n`, "utf8");
      packageFiles.push({
        relativePath: "sota-installed.json",
        stagedFile: statePath,
        mode: "100644"
      });

      send(65, `Verified ${packageFiles.length - 1} files. Installing ${changedComponents.length} package(s)...`);
      const transaction = applyStagedFiles(packageFiles, send, 65, 98);
      transaction.commit();
      fs.rmSync(stagePath, { recursive: true, force: true });
      send(100, `SOTA complete: ${changedComponents.join(", ")} updated.`, true);
      res.end();
      systemUpdateInProgress = false;
    } catch (error) {
      try { fs.rmSync(stagePath, { recursive: true, force: true }); }
      catch (cleanupError) { console.error("Could not clean staged SOTA update:", cleanupError); }
      console.error("SOTA update failed:", error);
      send(0, `SOTA update failed: ${error.message}`, true);
      res.end();
      systemUpdateInProgress = false;
    }
  })();
});

app.get("/sysinfo", (req, res) => {
  const cpus = os.cpus();
  res.json({
    OS: `mariowOS (${currentOS})`, Kernel: `${os.type()} ${os.release()}`, Uptime: os.uptime(),
    CPU: `${cpus[0].model}`, RAM: `${Math.round(os.totalmem() / 1048576)} MB`
  });
});

app.get("/api/system/storage", (req, res) => {
  try {
    const stats = fs.statfsSync(__dirname);
    const totalBytes = stats.blocks * stats.bsize;
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
    const usagePercent = totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
    res.json({ success: true, totalBytes, usedBytes, usagePercent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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

// --- PASSWORD VERIFICATION ---
app.post("/api/system/verify-password", async (req, res) => {
  const { password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  if (!currentConfig.passwordHash) return res.json({ success: true });
  
  const match = await bcrypt.compare(password, currentConfig.passwordHash);
  res.json({ success: match });
});

// --- REMOTE EXECUTION ---
app.post("/api/remote/exec", (req, res) => {
  const { command, password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  
  // Authenticate remote execution request
  bcrypt.compare(password || "", currentConfig.passwordHash || "", (err, match) => {
    if (!match && currentConfig.passwordHash) {
      return res.status(403).json({ success: false, error: "Unauthorized: Invalid password" });
    }
    
    // Execute command like a standard .sh behavior
    exec(command, (execErr, stdout, stderr) => {
      res.json({ 
        success: !execErr, 
        output: stdout || stderr || (execErr ? execErr.message : "") 
      });
    });
  });
});

function resolveVirtualPath(targetPath) {
  const requestedPath = typeof targetPath === 'string' && targetPath ? targetPath : '/home';
  const virtualPath = path.posix.normalize(requestedPath.replace(/\\/g, '/'));
  if (!virtualPath.startsWith('/')) return null;

  const isHome = virtualPath === '/home' || virtualPath.startsWith('/home/');
  const rootPath = path.resolve(__dirname, ...(isHome ? ['desktop', 'home'] : []));
  const subPath = isHome ? virtualPath.slice('/home'.length) : virtualPath.slice(1);
  const realPath = path.resolve(rootPath, `.${subPath}`);
  if (realPath !== rootPath && !realPath.startsWith(`${rootPath}${path.sep}`)) return null;

  return { realPath, isReadOnly: !isHome };
}

app.get("/api/system/files", (req, res) => {
  const targetPath = req.query.path || '/home';
  const resolved = resolveVirtualPath(targetPath);
  
  if (!resolved) return res.status(403).json({ success: false, error: "Access denied" });

  try {
    if (!fs.existsSync(resolved.realPath)) {
      if (targetPath === '/home') {
        fs.mkdirSync(resolved.realPath, { recursive: true });
        ['Documents', 'Downloads', 'Pictures', 'Videos', 'Desktop'].forEach(folder => {
          fs.mkdirSync(path.join(resolved.realPath, folder), { recursive: true });
        });
      } else {
        return res.status(404).json({ success: false, error: "Directory not found" });
      }
    }
    if (!fs.statSync(resolved.realPath).isDirectory()) {
      return res.status(400).json({ success: false, error: "Path is not a directory" });
    }
    
    const items = fs.readdirSync(resolved.realPath, { withFileTypes: true });
    const contents = items.map(item => ({
      name: item.name,
      type: item.isDirectory() ? 'folder' : 'file',
      ext: path.extname(item.name).toLowerCase(),
      size: item.isDirectory() ? '--' : (fs.statSync(path.join(resolved.realPath, item.name)).size / 1024).toFixed(1) + ' KB',
      date: fs.statSync(path.join(resolved.realPath, item.name)).mtime.toLocaleDateString()
    }));
    
    contents.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'folder' ? -1 : 1;
    });

    res.json({ success: true, contents, isReadOnly: resolved.isReadOnly });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/system/files/create-folder", (req, res) => {
  const resolved = resolveVirtualPath(req.body.path);
  if (!resolved || resolved.isReadOnly) return res.status(403).json({ error: "Directory is read-only" });
  
  try {
    const folderName = (req.body.name || '').trim();
    if (!folderName || folderName === '.' || folderName === '..' || folderName.includes('/') || folderName.includes('\\')) {
      return res.status(400).json({ error: "Invalid folder name" });
    }
    fs.mkdirSync(path.join(resolved.realPath, folderName));
    res.json({ success: true });
  } 
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/system/files/rename", (req, res) => {
  const resolved = resolveVirtualPath(req.body.path);
  if (!resolved || resolved.isReadOnly) return res.status(403).json({ success: false, error: "Directory is read-only" });

  const oldName = (req.body.oldName || '').trim();
  const newName = (req.body.newName || '').trim();

  if (!oldName || !newName) return res.status(400).json({ success: false, error: "Names cannot be empty" });
  if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
    return res.status(400).json({ success: false, error: "Invalid new name" });
  }

  try {
    const oldPath = path.join(resolved.realPath, oldName);
    const newPath = path.join(resolved.realPath, newName);

    if (!fs.existsSync(oldPath)) return res.status(404).json({ success: false, error: "Item not found" });
    if (fs.existsSync(newPath) && oldName.toLowerCase() !== newName.toLowerCase()) {
      return res.status(409).json({ success: false, error: "An item with this name already exists" });
    }

    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/system/files/delete", (req, res) => {
  const resolved = resolveVirtualPath(req.body.path);
  if (!resolved || resolved.isReadOnly) return res.status(403).json({ error: "Directory is read-only" });
  
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ success: false, error: "Invalid item name" });
    }
    const target = path.join(resolved.realPath, name);
    if (!fs.existsSync(target)) return res.status(404).json({ error: "Item not found" });
    if (fs.statSync(target).isDirectory()) {
      if (req.body.recursive === false) return res.status(400).json({ success: false, error: "Directory removal requires recursive confirmation" });
      fs.rmSync(target, { recursive: true });
    } else {
      fs.unlinkSync(target);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/system/files/upload", (req, res) => {
  const resolved = resolveVirtualPath(req.body.path);
  if (!resolved || resolved.isReadOnly) return res.status(403).json({ error: "Directory is read-only" });
  
  try {
    const buffer = Buffer.from(req.body.data, 'base64');
    fs.writeFileSync(path.join(resolved.realPath, req.body.name), buffer);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/system/files/content", (req, res) => {
  const resolved = resolveVirtualPath(req.query.path);
  if (!resolved) return res.status(403).json({ success: false, error: "Access denied" });
  
  try {
    const fileName = typeof req.query.name === 'string' ? req.query.name : '';
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }
    const filePath = path.join(resolved.realPath, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: "File not found" });
    if (fs.statSync(filePath).isDirectory()) return res.status(400).json({ success: false, error: "Target is a directory" });
    const content = fs.readFileSync(filePath, "utf8");
    res.json({ success: true, content });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/system/files/content", (req, res) => {
  const resolved = resolveVirtualPath(req.body.path);
  if (!resolved || resolved.isReadOnly) return res.status(403).json({ success: false, error: "Directory is read-only" });

  try {
    const fileName = (req.body.name || '').trim();
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }
    const filePath = path.join(resolved.realPath, fileName);
    fs.writeFileSync(filePath, req.body.content !== undefined ? req.body.content : "", "utf8");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

httpServer = app.listen(PORT, () => console.log(`kernel booted on [${currentOS}] at http://127.0.0.1:${PORT}`));
httpServer.on('error', error => {
  console.error('kernel failed to bind its HTTP server:', error);
  process.exit(1);
});