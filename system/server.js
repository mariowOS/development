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

// Load local overrides (e.g. MARIOWOS_MAIL_RELAY_URL) from system/.env without overriding real env vars.
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

// SECURITY (D-01): defence-in-depth Content-Security-Policy + hardening headers.
// The desktop and every app are served from this origin and loaded as same-origin
// iframes, so one policy set here covers them all. This is LAYER 1: it does NOT yet
// forbid inline scripts/handlers ('unsafe-inline' stays, because the whole UI is
// built on inline code — removing it is a separate, larger refactor together with
// sanitising the innerHTML sinks). What it DOES buy right now:
//   - connect-src 'self'  -> a successful XSS cannot exfiltrate data to a remote
//                            server or beacon out; every app already talks only to
//                            same-origin /api/* routes (the backend proxies outward).
//   - script-src pinned   -> no stage-2 payload can be pulled from an attacker CDN;
//                            only self + the CDN the OS genuinely uses are allowed.
//   - object-src 'none', base-uri 'self', frame-ancestors 'self' -> kill <object>/
//                            <embed>, <base> hijacking and clickjacking/re-framing.
// The in-OS browser runs in a <webview> (its own browsing context), so external
// sites it visits are unaffected by this header.
//
// Third-party Store apps are the exception: they are served from a SEPARATE origin
// (APPS_ORIGIN, see "THIRD-PARTY APP ISOLATION" below) so they cannot reach this one.
const APPS_HOST = process.env.MARIOWOS_BIND_HOST || "127.0.0.1";
const APPS_PORT = Number(process.env.MARIOWOS_APPS_PORT || Number(process.env.MARIOWOS_PORT || 3000) + 1);
const APPS_ORIGIN = `http://${APPS_HOST}:${APPS_PORT}`;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'unsafe-eval' is required by the Monaco editor (ACode); 'unsafe-inline' by the
  // OS's inline handlers/scripts. cdnjs serves Monaco + JSZip.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  // External iframes the shell embeds (homepage, chat widgets) are https only; the
  // browser app itself uses a <webview>, not an iframe, so it is not constrained here.
  `frame-src 'self' https: ${APPS_ORIGIN}`,
  // Monaco (ACode) spins up its language worker from a data: URL. 'blob:' covers the
  // common pattern; 'data:' is needed for this Monaco build. (Hosting Monaco from the
  // bundled local copy in desktop/assets/vendor/monaco would let this drop to 'self'.)
  "worker-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'"
].join("; ");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

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

// Pure version & URL-validation helpers live in ./lib/validation.js so they can be
// unit-tested without booting the server (see system/test/validation.test.js).
// Semantics unchanged:
//  - isNewerVersion: the updater only ever offers a strictly NEWER build (no silent
//    downgrade); unparseable versions fall back to "different means newer".
//  - isAllowedRepoUrl (SECURITY A-07 adjacent): store apps clone/pull/update ONLY from
//    https github.com / raw.githubusercontent.com repo URLs — never a local path, a
//    non-https transport, or an "ext::"/option-injection URL.
const {
  parseVersion,
  comparePrerelease,
  compareVersions,
  isNewerVersion,
  getRawGithubUrl,
  isAllowedRepoUrl,
  getRepoRawUrls
} = require("./lib/validation");

const { createRollbackPoint, readRollbackPoint } = require("./lib/rollback");
const { createMailClient } = require("./lib/mail");
const { createSessions, createPasswordGuard } = require("./lib/session");
const { createUsers, OWNER_ID } = require("./lib/users");

function readStagedVersion(stagePath) {
  try { return JSON.parse(fs.readFileSync(path.join(stagePath, "version.json"), "utf8")).version || null; }
  catch (e) { return null; }
}

// Read a repo's declared version from its version.json (the app author's own file).
async function fetchRepoVersion(repoUrl) {
  for (const url of getRepoRawUrls(repoUrl, "version.json")) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = JSON.parse(await r.text());
      if (data && typeof data.version === "string") return data.version;
    } catch (e) { /* try next branch */ }
  }
  return null;
}

// Read the version.json an installed app shipped with (local copy).
function readInstalledAppVersion(appId) {
  try {
    const p = path.join(__dirname, "desktop", "apps", appId, "version.json");
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return (data && typeof data.version === "string") ? data.version : null;
  } catch (e) { return null; }
}

// --- UPDATE AUTHENTICITY (A-07) ---
// The system updater clones the official repo over HTTPS. That protects the download in
// transit but not against a compromised source: whoever controls the repository controls
// both the code and any plain hash list. Real authenticity needs a signature checked
// against a key that ships with the device.
//
// Opt-in by presence of update-pubkey.pem (created by tools/release-keys.js). When it is
// present, the updater REFUSES any release whose release-manifest.json is not signed by
// the matching private key or whose files do not match it (lib/update-checks.js).
// When it is absent, updates proceed unsigned and a warning is logged.
const updatePubKeyFile = path.join(__dirname, "update-pubkey.pem");
function getUpdatePublicKey() {
  try { return fs.readFileSync(updatePubKeyFile, "utf8"); } catch (e) { return null; }
}

// --- FILESYSTEM INTEGRITY / VERIFIED BOOT (tamper detection) ---
// The recovery screen offers "verify filesystem integrity". This backs it with a real
// check: a signed manifest (system/integrity-manifest.json, map of path -> sha256)
// records the hashes of the files that make up a stock build. We re-hash those files
// and report any that were modified, replaced or removed. This is the mariowOS analog
// of Android verified boot: if a locked system (flashing NOT unlocked) has been
// tampered with, the UI should refuse and prompt the user to reflash clean stock.
//
// Opt-in by presence of the manifest; its own signature is verified against
// update-pubkey.pem so a tamperer cannot simply rewrite the manifest to match.
const integrityManifestFile = path.join(__dirname, "integrity-manifest.json");
function sha256File(absPath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

function verifyFilesystemIntegrity() {
  let raw;
  try { raw = fs.readFileSync(integrityManifestFile); }
  catch (e) { return { available: false, reason: "No integrity manifest on this build." }; }

  // The manifest must itself be authentic, or tamper detection is pointless.
  const pubKey = getUpdatePublicKey();
  let signatureVerified = false;
  if (pubKey) {
    try {
      const sig = Buffer.from(fs.readFileSync(integrityManifestFile + ".sig", "utf8").trim(), "base64");
      signatureVerified = crypto.verify(null, raw, pubKey, sig);
    } catch (e) { signatureVerified = false; }
    if (!signatureVerified) {
      return { available: true, signed: true, signatureVerified: false, tampered: true,
        reason: "The integrity manifest itself is missing a valid signature.", modified: [], missing: [] };
    }
  }

  let manifest;
  try { manifest = JSON.parse(raw.toString()); } catch (e) { return { available: false, reason: "Manifest is not valid JSON." }; }
  const files = (manifest && manifest.files) || {};
  const modified = [], missing = [];
  for (const [rel, expected] of Object.entries(files)) {
    // Keep the manifest inside the install tree; never let it point elsewhere.
    const abs = path.resolve(__dirname, rel);
    if (abs !== __dirname && !abs.startsWith(__dirname + path.sep)) { modified.push(rel); continue; }
    try {
      if (sha256File(abs) !== expected) modified.push(rel);
    } catch (e) { missing.push(rel); }
  }
  const tampered = modified.length > 0 || missing.length > 0;
  return {
    available: true,
    signed: !!pubKey,
    signatureVerified: pubKey ? signatureVerified : undefined,
    tampered,
    modified,
    missing,
    // Verified-boot behaviour: a tampered, still-locked system should be sent to recovery.
    locked: !config.allowFlashing,
    recommendReflash: tampered && !config.allowFlashing
  };
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
  updateChannel: "stable",
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
  if (!config.updateChannel) config.updateChannel = "stable";
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

// Emails go through the mariowOS mail relay (lib/mail.js): no mail password on the device.
const mail = createMailClient({
  relayUrl: process.env.MARIOWOS_MAIL_RELAY_URL || "https://mariowos-mail.mariowos.workers.dev",
  errorLogFile: path.join(__dirname, "mail-error.log")
});

function saveConfig() {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email.trim());
}

// One-time codes are generated, stored and checked by the mail relay.
const sendCodeEmail = (purpose, email) => mail.sendCode(purpose, email, config.username);
const checkCode = (purpose, email, code) => mail.checkCode(purpose, email, code);

// --- SESSION AUTHENTICATION (A-02) --- see lib/session.js
// SHA-256 of session keys that were once published in the GitHub repositories. Anyone
// could sign a session with them, so a device still using one gets a fresh key (its
// user simply logs in again).
const LEAKED_SESSION_KEY_HASHES = new Set([
  "2feed71c3d843835e71c2a9963de5c671cd0ed0ab4da984466210bf7e2f0b9b2"
]);
const { issueSession, clearSession, hasValidSession, readSession, signAppToken, verifyAppToken } = createSessions({
  keyFile: path.join(__dirname, "session.key"),
  leakedKeyHashes: LEAKED_SESSION_KEY_HASHES,
  secureCookie: process.env.MARIOWOS_SECURE_COOKIE === "1"
});
const { comparePassword, lockSeconds: passwordLockSeconds } = createPasswordGuard((candidate, hash) => bcrypt.compare(candidate, hash));
const users = createUsers({ baseDir: __dirname, getConfig: () => config, saveConfig });

// Standard (non-admin) accounts: whatever installs software, runs commands or changes the
// system for everyone belongs to administrators. Enforced here, whatever the UI shows.
const ADMIN_ONLY_ROUTES = [
  /^\/api\/store\/(install|uninstall|do-upgrade|publish|eula)\b/,
  /^\/api\/remote\/exec\b/, /^\/api\/sandbox\//, /^\/api\/recovery\//,
  /^\/api\/system\/(factory-reset|reset-settings|reset-desktop|restore|backup|boot-logo|update-channel|keyring|ota-update|sota-update)\b/,
  /^\/api\/users\/(create|update|delete|reset-password)\b/,
  /^\/api\/rules\/(save|enabled)\b/,
  /^\/(save-settings|clear-settings|set-password|clear-password|upload-wallpaper)$/
];
// Reading is fine, except where the read itself acts or hands out secrets.
const ADMIN_ONLY_READS = /^\/api\/system\/(backup|keyring|ota-update|sota-update)\b/;
function requireAdminFor(req, res, next) {
  if (req.user?.admin || !ADMIN_ONLY_ROUTES.some(route => route.test(req.path))) return next();
  if ((req.method === "GET" || req.method === "HEAD") && !ADMIN_ONLY_READS.test(req.path)) return next();
  res.status(403).json({ success: false, code: "ADMIN_ONLY", error: "Only an administrator can do this." });
}

// Routes that must stay reachable WITHOUT a session: the login/recovery flow itself,
// health checks, and the Electron shell's own token-authenticated power controls.
const PREAUTH_POST = new Set([
  "/login", "/set-password", "/forgot-password", "/reset-password",
  "/api/email/send-code", "/api/email/verify-code", "/api/system/frp-unlock",
  "/api/system/shutdown", "/api/system/reboot"
]);

function requireSession(req, res, next) {
  // Reads are left to the route-level checks already in place; this gate covers every
  // state-changing method, which is where the dangerous routes live.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (PREAUTH_POST.has(req.path)) return next();
  // Fresh install / no password yet: nothing to protect, let setup proceed.
  if (!config.passwordHash) return next();
  if (hasValidSession(req)) return next();
  return res.status(401).json({ success: false, error: "Authentication required. Please log in again." });
}

// --- PER-APP ENDPOINT PERMISSIONS (transparent capability model) ---
// Goal: let only the app that owns an endpoint call it (e.g. only the Terminal app
// may call the terminal/exec routes). This is the HONEST version of that idea:
//  - The rules live in a plain, readable file (system/app-permissions.json), not an
//    obfuscated blob. Obscurity is not a security boundary; hiding the rules would
//    only make auditing harder without stopping anyone.
//  - It is OFF by default (`enforced: false`) so it never breaks apps until the
//    desktop shell is wired to mint and send per-app tokens (see /api/app/token).
//  - HONEST LIMITATION: apps run as same-origin iframes, so this gives
//    least-privilege-by-convention and accountability, NOT hard isolation against a
//    malicious same-origin app. Real isolation would require per-app origins
//    (separate partitions / cross-origin frames) — a larger frontend change.
const appPermissionsFile = path.join(__dirname, "app-permissions.json");
function loadAppPermissions() {
  try {
    const data = JSON.parse(fs.readFileSync(appPermissionsFile, "utf8"));
    return { enforced: !!data.enforced, rules: Array.isArray(data.rules) ? data.rules : [] };
  } catch (e) { return { enforced: false, rules: [] }; }
}

function enforceAppPermissions(req, res, next) {
  const perms = loadAppPermissions();
  if (!perms.enforced) return next();
  const rule = perms.rules.find(r => typeof r.prefix === "string" && req.path.startsWith(r.prefix));
  if (!rule) return next(); // endpoint not restricted to a specific app
  const payload = verifyAppToken(req.get("x-app-token"));
  if (!payload || !Array.isArray(rule.apps) || !rule.apps.includes(payload.appId)) {
    return res.status(403).json({ success: false, error: "This app is not allowed to use this endpoint." });
  }
  next();
}

// --- THIRD-PARTY APP ISOLATION ---
// Store apps from developers other than the mariowOS team run on their own origin
// (APPS_ORIGIN, a second port), not as same-origin iframes of the shell. The browser
// then keeps them away from the shell's DOM, cookies and storage, and:
//  - they cannot READ this API: no CORS headers are ever sent to them;
//  - they cannot WRITE to it: every state-changing request carrying a foreign Origin
//    is refused below (this also stops any other web page from posting here);
//  - they cannot sneak back onto this origin: their files are not served here.
const TRUSTED_APP_OWNERS = new Set(["mariowos", "mariowstech"]);
function isThirdPartyApp(installed) {
  if (!installed || !installed.repoUrl) return false; // built into the OS
  const owner = String(installed.repoUrl).match(/^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/([^/]+)\//i);
  return !owner || !TRUSTED_APP_OWNERS.has(owner[1].toLowerCase());
}
const thirdPartyAppIds = () => new Set((config.installedApps || []).filter(isThirdPartyApp).map(installed => installed.appId));

const SHELL_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://${APPS_HOST}:${PORT}`]);
function rejectForeignWrites(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin");
  // No Origin: a non-browser client on this machine (the launcher, curl). Same origin: the shell.
  if (!origin || SHELL_ORIGINS.has(origin)) return next();
  return res.status(403).json({ success: false, error: "Requests from other origins are not allowed." });
}
app.use(rejectForeignWrites);

app.use("/desktop/apps/:appId", (req, res, next) => thirdPartyAppIds().has(req.params.appId)
  ? res.status(403).send("This app runs in its own sandbox.") : next());

app.use(bodyParser.urlencoded({ extended: true }));
// Notes can hold pasted images, so their route gets its own larger body limit (below).
const jsonParser = express.json();
const OWN_BODY_PARSER = new Set(["/api/system/notes", "/api/system/files/upload", "/api/system/files/upload-raw"]);
app.use((req, res, next) => OWN_BODY_PARSER.has(req.path) ? next() : jsonParser(req, res, next));
app.use(requireSession);
app.use(users.middleware(readSession, clearSession));
app.use(requireAdminFor);
app.use(enforceAppPermissions);

require("./spotify").registerSpotifyRoutes(app, {
  getConfig: () => config, saveConfig, hasValidSession, port: PORT
});
const requireAuthJson = (req, res, next) => (!config.passwordHash || hasValidSession(req))
  ? next() : res.status(401).json({ success: false, error: "Authentication required. Please log in again." });
require("./media-session").registerMediaSessionRoutes(app, { requireAuth: requireAuthJson });
require("./bluetooth-watch").registerBluetoothWatchRoutes(app, { requireAuth: requireAuthJson });
require("./online-services").registerOnlineServiceRoutes(app, { getConfig: () => config, saveConfig, requireAuth: requireAuthJson });

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

// A language is available when it is listed in locales/languages.json and has its
// locales/<code>.json (English is built into the pages and needs no file).
const LOCALES_DIR = path.join(__dirname, "desktop", "assets", "locales");
function isAvailableLanguage(code) {
  if (code === "auto" || code === "en") return true;
  if (typeof code !== "string" || !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(code)) return false;
  return Object.hasOwn(readLanguages(), code) && fs.existsSync(path.join(LOCALES_DIR, `${code}.json`));
}
function readLanguages() {
  try { return { en: "English", ...JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "languages.json"), "utf8")) }; }
  catch { return { en: "English" }; }
}
// "auto" follows the computer: Electron sends its language as Accept-Language.
function resolveLanguage(preference, acceptLanguage) {
  if (preference !== "auto") return preference && preference !== "en" && isAvailableLanguage(preference) ? preference : "en";
  for (const part of String(acceptLanguage || "").toLowerCase().split(",")) {
    const tag = part.split(";")[0].trim();
    for (const code of [tag, tag.split("-")[0]]) if (code && code !== "auto" && isAvailableLanguage(code)) return code;
  }
  return "en";
}
// The page's language and translations as a script, so they are ready before the
// page's own scripts run (see desktop/assets/i18n.js).
app.get("/desktop/assets/i18n-data.js", (req, res) => {
  const preference = config.language || "en";
  const language = resolveLanguage(preference, req.get("accept-language"));
  let dictionary = {};
  if (language !== "en") {
    try { dictionary = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${language}.json`), "utf8")); } catch {}
  }
  const data = JSON.stringify({ preference, language, languages: readLanguages(), dictionary }).replace(/</g, "\\u003c");
  res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
  res.send(`window.__mariowOSI18nData = ${data};\n`);
});

// Static files are the actual desktop shell. The login screen, settings pages, and app folders
// are served as normal web assets from the filesystem, which keeps the OS feel web-based and easy to tweak.
// The notes database lives under desktop/ for historical reasons: never serve it as a static file.
app.get("/desktop/notes-db.json", (req, res) => res.status(404).end());
// Home folders are read through the file API, as their owner: never as plain static files.
app.use("/desktop/home", (req, res) => res.status(404).end());
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));
app.use("/lockscreen", express.static(path.join(__dirname, "lockscreen")));

app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  next();
});

// SECURITY (M-04): every upload caps its file size so a client cannot exhaust disk or
// memory. Image uploads also restrict the MIME type. Shared cap for images:
const IMAGE_UPLOAD_LIMIT = { fileSize: 8 * 1024 * 1024 };

const avatarUpload = multer({
  limits: IMAGE_UPLOAD_LIMIT,
  storage: multer.diskStorage({
    // Each account has its own picture (the owner's is desktop/assets/avatar.user.png).
    destination: (req, file, cb) => { const target = users.avatarOf(users.find(req.user?.id)); fs.mkdirSync(path.dirname(target), { recursive: true }); cb(null, path.dirname(target)); },
    filename: (req, file, cb) => cb(null, path.basename(users.avatarOf(users.find(req.user?.id))))
  }),
  fileFilter: (req, file, cb) => cb(null, ["image/png", "image/jpeg"].includes(file.mimetype))
});

app.post("/upload-avatar", avatarUpload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
  res.json({ success: true, message: "Avatar uploaded successfully!" });
});

app.post("/reset-avatar", (req, res) => {
  const avatarPath = users.avatarOf(users.find(req.user?.id));
  if (fs.existsSync(avatarPath)) { fs.unlinkSync(avatarPath); }
  res.json({ success: true, message: "Avatar reset!" });
});

const wallpaperUpload = multer({
  limits: IMAGE_UPLOAD_LIMIT,
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
  limits: IMAGE_UPLOAD_LIMIT,
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
  if (!config.email || !config.verified || !mail.configured) return;
  if (!config.mailToken) {
    console.warn("[mail] daily report skipped: verify your email again in Settings to enable it.");
    return;
  }
  const result = await mail.sendDailyReport({ email: config.email, token: config.mailToken, username: config.username });
  if (result.ok) {
    config.lastSent = Date.now();
    saveConfig();
  } else {
    console.error("Failed to send daily email:", result.error);
  }
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

// Windows: Wi-Fi and Bluetooth go through lib/windows-radios.ps1, which needs no admin rights.
function runWindowsRadios(args, env = {}) {
  const script = path.join(__dirname, "lib", "windows-radios.ps1");
  return new Promise((resolve, reject) => {
    childProcess.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true, timeout: 30000, env: { ...process.env, ...env } }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const result = JSON.parse(stdout);
          return result.success ? resolve(result) : reject(new Error(result.error || "Radio command failed"));
        } catch (parseError) { reject(parseError); }
      });
  });
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => exec(cmd, err => (err ? reject(err) : resolve())));
}

function setWifiPower(on) {
  if (currentOS === "win32") return runWindowsRadios(["-Action", "set", "-Kind", "WiFi", "-On", on ? "1" : "0"]);
  if (currentOS === "darwin") return runCommand(`networksetup -setairportpower en0 ${on ? 'on' : 'off'}`);
  return runCommand(`nmcli radio wifi ${on ? 'on' : 'off'}`);
}

function setBluetoothPower(on) {
  if (currentOS === "win32") return runWindowsRadios(["-Action", "set", "-Kind", "Bluetooth", "-On", on ? "1" : "0"]);
  if (currentOS === "darwin") return runCommand(`blueutil -p ${on ? '1' : '0'}`);
  return runCommand(`rfkill ${on ? 'unblock' : 'block'} bluetooth`);
}

// Airplane mode turns every radio off and remembers how they were, to put them back after.
async function setAirplaneMode(on) {
  const qs = config.quickSettings;
  if (on) {
    qs.radiosBeforeAirplane = { wifi: qs.wifi !== false, bluetooth: qs.bluetooth !== false };
    await Promise.allSettled([setWifiPower(false), setBluetoothPower(false)]);
    qs.wifi = false;
    qs.bluetooth = false;
    return;
  }
  const before = qs.radiosBeforeAirplane || { wifi: true, bluetooth: true };
  await Promise.allSettled([setWifiPower(before.wifi), setBluetoothPower(before.bluetooth)]);
  qs.wifi = before.wifi;
  qs.bluetooth = before.bluetooth;
  delete qs.radiosBeforeAirplane;
}

app.post("/api/system/quick-settings", async (req, res) => {
  const { setting, value } = req.body;
  if (!setting || value === undefined) {
    return res.status(400).json({ success: false, error: "Dati mancanti" });
  }

  // --- HARDWARE POWER TOGGLES ---
  // The saved state only changes once the hardware did, so the panel can't show a state it isn't in.
  const hardware = { wifi: setWifiPower, bluetooth: setBluetoothPower, airplane: setAirplaneMode }[setting];
  if (hardware) {
    try {
      await hardware(Boolean(value));
    } catch (error) {
      console.error(`${setting} toggle error:`, error.message);
      return res.status(500).json({ success: false, error: error.message, quickSettings: config.quickSettings });
    }
  }

  config.quickSettings[setting] = value;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, quickSettings: config.quickSettings });
});

// Whether this machine has a battery at all: a plugged-in desktop and a fully charged laptop
// look the same to the page. The level and charging state then come live from the page.
let batteryPresence = null;
function detectBattery() {
  return new Promise(resolve => {
    if (currentOS === "linux") {
      try { return resolve(fs.readdirSync("/sys/class/power_supply").some(name => name.startsWith("BAT"))); }
      catch { return resolve(false); }
    }
    if (currentOS === "darwin") return exec("pmset -g batt", (err, stdout) => resolve(!err && stdout.includes("InternalBattery")));
    if (currentOS === "win32") {
      return childProcess.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Battery | Measure-Object).Count"],
        { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(!err && parseInt(stdout, 10) > 0));
    }
    resolve(false);
  });
}
app.get("/api/system/battery", async (req, res) => {
  batteryPresence ??= detectBattery();
  res.json({ present: await batteryPresence });
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
    // A live scan: netsh only reads the list Windows last cached.
    runWindowsRadios(["-Action", "scan"]).then(scan => {
      exec("netsh wlan show interfaces", (err, stdout) => {
        const match = !err && stdout.match(/^\s*SSID\s*:\s*(.+)$/m);
        const connectedSsid = match ? match[1].trim() : null;
        const networks = [].concat(scan.networks || [])
          .map(network => ({ ...network, connected: network.ssid === connectedSsid }))
          .sort((a, b) => b.connected - a.connected || b.signal - a.signal);
        config.quickSettings.wifi = scan.wifi !== false;
        config.quickSettings.bluetooth = scan.bluetooth !== false;
        res.json({ success: true, networks, wifi: config.quickSettings.wifi, bluetooth: config.quickSettings.bluetooth });
      });
    }).catch(error => {
      console.error("Wi-Fi scan error:", error.message);
      res.json({ success: true, networks: [] });
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

  // SECURITY (A-04): ssid/password are interpolated into a shell command. Reject any
  // value containing shell metacharacters or quotes so it cannot break out of the
  // quoted argument and inject commands. (See also the spawn() helper at the top of
  // this file for the preferred no-shell approach.)
  const SHELL_UNSAFE = /["'`$\\;&|<>\n\r]/;
  // Windows: a password goes through no shell at all, so any character is fine in it.
  if (currentOS === "win32" && password) {
    if (typeof ssid !== "string" || typeof password !== "string") {
      return res.status(400).json({ success: false, error: "Invalid SSID or password." });
    }
    return runWindowsRadios(["-Action", "connect", "-Ssid", ssid], { MARIOWOS_WIFI_PASSWORD: password }).then(() => {
      config.quickSettings.connectedWifi = ssid;
      config.quickSettings.wifi = true;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      res.json({ success: true, connectedWifi: ssid });
    }).catch(() => res.status(500).json({ success: false, error: "Unable to connect to the network." }));
  }
  if (typeof ssid !== "string" || SHELL_UNSAFE.test(ssid) ||
      (password !== undefined && password !== null &&
        (typeof password !== "string" || SHELL_UNSAFE.test(password)))) {
    return res.status(400).json({ success: false, error: "SSID or password contains invalid characters." });
  }

  let cmd = "";
  if (currentOS === "linux") {
    cmd = password ? `nmcli dev wifi connect "${ssid}" password "${password}"` : `nmcli dev wifi connect "${ssid}"`;
  } else if (currentOS === "win32") {
    cmd = `netsh wlan connect name="${ssid}"`;
  } else if (currentOS === "darwin") {
    cmd = password ? `networksetup -setairportnetwork en0 "${ssid}" "${password}"` : `networksetup -setairportnetwork en0 "${ssid}"`;
  }

  exec(cmd, (err) => {
    // On Windows a network without a saved profile fails here: ask the user for its password.
    if (err) return res.status(500).json({ success: false, needsPassword: currentOS === "win32", error: "Unable to connect to the network." });
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
    // The driver's "OK" only means paired: ask Windows what is connected right now.
    runWindowsRadios(["-Action", "bluetooth"]).then(result => {
      const devices = [].concat(result.devices || []);
      config.quickSettings.connectedBt = (devices.find(device => device.connected) || {}).name || null;
      res.json({ success: true, devices });
    }).catch(error => {
      console.error("Bluetooth devices error:", error.message);
      res.json({ success: true, devices: [] });
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

  // SECURITY (A-04): `target` is interpolated unquoted into a shell command. A MAC
  // address is all we should accept here; reject anything that isn't one so command
  // injection is impossible.
  if (typeof target !== "string" || !/^[0-9A-Fa-f:-]{1,32}$/.test(target)) {
    return res.status(400).json({ success: false, error: "Invalid Bluetooth target." });
  }

  // Windows has no public way to connect an audio device from an app: say so, never pretend.
  if (currentOS === "win32") return res.status(501).json({ success: false, unsupported: true });

  const isConnected = config.quickSettings.connectedBt === name;
  let cmd = "";
if (currentOS === "linux") {
    cmd = `bluetoothctl ${isConnected ? "disconnect" : "connect"} ${target}`;
  } else if (currentOS === "darwin") {
    cmd = `blueutil --${isConnected ? "disconnect" : "connect"} ${target}`;
  }
  // SECURITY (D-04): win32 had `echo Toggle Bluetooth for ${name}` here — `name` is
  // user-controlled and was NOT validated (only `target` is), so it was a real shell
  // command-injection sink (e.g. name = "x & whoami"), reachable by any session WITHOUT
  // the account password. The echo was a no-op placeholder, so it is removed entirely;
  // only the validated-MAC branches ever touch the shell now, and never run an empty cmd.

  const applyToggle = () => {
    config.quickSettings.connectedBt = isConnected ? null : name;
    config.quickSettings.bluetooth = true;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    res.json({ success: true, connectedBt: config.quickSettings.connectedBt });
  };

  if (cmd) exec(cmd, applyToggle);
  else applyToggle();
});

// --- BACKUP & RESTORE ---
// This section protects user config and makes it easy to save and restore a machine state.
// In practice, it is one of the most important pieces for anyone building a custom mariowOS image.
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // M-04

app.get("/api/system/backup", requireAuthJson, (req, res) => {
  // Send current config, but explicitly remove the passwordHash for security.
  // Accounts are not settings: their names and password hashes never leave in a backup.
  const safeConfig = { ...config };
  delete safeConfig.passwordHash;
  delete safeConfig.users;
  res.json(safeConfig);
});

app.post("/api/system/restore", backupUpload.single("backupFile"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

  // SECURITY (D-02): a restore overwrites the entire config (rules, calendar, account
  // email, installed-app list...). Require the account password so a rogue same-origin
  // app can't silently swap the user's config. No password set (first-run / welcome
  // import) => nothing to protect, proceed.
  if (config.passwordHash) {
    const ok = await comparePassword(String((req.body && req.body.password) || ""), config.passwordHash);
    if (!ok) return res.status(403).json({ success: false, error: "Incorrect password." });
  }

  try {
    const importedConfig = JSON.parse(req.file.buffer.toString());
    
    // Preserve the user's current password hash, don't overwrite it with the backup's missing one
    const currentPass = config.passwordHash;
    // A backup can never add or change accounts: the ones on this machine stay.
    config = { ...importedConfig, passwordHash: currentPass, users: config.users || [] };
    
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
// Verified-boot check backing the recovery "verify filesystem integrity" screen.
// Read-only; reports which stock files were modified/removed and whether the system
// should be sent to a clean reflash.
app.get("/api/recovery/verify-integrity", (req, res) => {
  try {
    res.json({ success: true, ...verifyFilesystemIntegrity() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Deliberate, authenticated "unlock" of custom flashing (the Android OEM-unlock analog).
// Requires the account password so only the local logged-in user can flip it — it can
// no longer be toggled by a plain request (that was C-03). The unlocked state is meant
// to be surfaced to the user by the UI as a standing "integrity not guaranteed" warning.
app.post("/api/recovery/set-flashing", async (req, res) => {
  const { password, enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ success: false, error: "`enabled` must be boolean." });
  if (!config.passwordHash) return res.status(403).json({ success: false, error: "Set an account password first." });
  const ok = await comparePassword(password, config.passwordHash);
  if (!ok) return res.status(403).json({ success: false, error: "Incorrect password." });
  config.allowFlashing = enabled;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, allowFlashing: enabled,
    note: enabled
      ? "Custom flashing unlocked. Unsigned builds can now be installed deliberately; the system is no longer integrity-guaranteed."
      : "Custom flashing locked. Only verified stock updates will be accepted." });
});

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
    const match = await comparePassword(payload, config.passwordHash);
    if (match) {
      config.frpLock = false;
      config.passwordHash = null; // Cleared for fresh setup
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      return res.json({ success: true });
    }
    return res.json({ success: false, error: "Incorrect password." });
  } 
  else if (type === "file") {
    // SECURITY (C-04): never rebuild the whole config from an uploaded file. That
    // let a caller set an arbitrary passwordHash and take over the account while
    // bypassing the FRP lock. A recovery file may only prove ownership by carrying
    // the SAME passwordHash already stored; it can never change credentials here.
    try {
      const importedConfig = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!importedConfig || typeof importedConfig !== 'object' ||
          !config.passwordHash ||
          importedConfig.passwordHash !== config.passwordHash) {
        return res.json({ success: false, error: "Invalid credentials file." });
      }
      config.frpLock = false;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      return res.json({ success: true });
    } catch (e) {
      return res.json({ success: false, error: "Invalid credentials file." });
    }
  }
});

// 4. Recovery Debug Terminal Endpoint
app.post("/api/recovery/debug", async (req, res) => {
  // SECURITY (C-01): this route runs arbitrary shell commands. It was previously
  // gated only by the `allowFlashing` flag, which an unauthenticated caller could
  // turn on by itself (see C-03). It now requires BOTH the flag AND the account
  // password, and the flag is off by default (config.json).
  if (!config.allowFlashing) {
    return res.status(403).json({ error: "locked", message: "Flashing/Debug is disabled in Functions Lab." });
  }
  if (!config.passwordHash) {
    return res.status(403).json({ error: "locked", message: "Set a password before using the debug terminal." });
  }
  const match = await comparePassword(String(req.body.password || ""), config.passwordHash);
  if (!match) {
    return res.status(403).json({ error: "unauthorized", message: "Invalid password." });
  }
  if (typeof req.body.command !== "string" || !req.body.command.trim()) {
    return res.status(400).json({ error: "bad-request", message: "No command provided." });
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

// --- GESTIONE CANALI DI AGGIORNAMENTO ---
function getUpdateChannel() {
  const c = (config.updateChannel || "stable").toLowerCase();
  if (c === "beta") return "beta";
  if (c === "insiders") return "insiders";
  return "stable";
}

app.get('/api/system/update-channel', (req, res) => {
  res.json({ channel: getUpdateChannel() });
});

app.post('/api/system/update-channel', (req, res) => {
  if (!config.verified) {
    return res.status(400).json({ success: false, error: "Verify your email in Settings first." });
  }
  const { channel } = req.body;
  if (["stable", "beta", "insiders"].includes(channel)) {
    config.updateChannel = channel;
    saveConfig();
    res.json({ success: true, channel });
  } else {
    res.status(400).json({ success: false, error: "Invalid channel" });
  }
});

// --- EMAIL VERIFICATION ---
app.post("/api/email/send-code", async (req, res) => {
  const email = String(req.body.email || config.email || "").trim();
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email address." });
  const result = await sendCodeEmail("verify", email);
  if (!result.ok) return res.status(result.status).json({ success: false, error: result.error, retryAfter: result.retryAfter });
  res.json({ success: true, message: "Code sent to " + email });
});

app.post("/api/email/verify-code", async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email address." });
  const result = await checkCode("verify", email, req.body.code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  config.email = email;
  config.verified = true;
  config.mailToken = result.token || null;
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
  const result = await checkCode("reset", email, code);
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
  // Which account: the login screen sends its id; without one it is the owner, as before.
  const account = users.find(typeof req.body.userId === "string" && req.body.userId ? req.body.userId : OWNER_ID);
  if (!account || !account.passwordHash) return res.status(401).send("Unknown account.");
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).send("Password is required.");
  }
  
  if (passwordLockSeconds() > 0) {
    return res.status(429).send(`Too many attempts. Try again in ${passwordLockSeconds()} seconds.`);
  }
  const match = await comparePassword(password, account.passwordHash);
  if (!match) return res.status(401).send("Incorrect password.");
  users.ensureHome(account);
  issueSession(res, account.id); // A-02: start an authenticated session for subsequent API calls.
  res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
});

// Personalisation from Settings → Wallpaper & Style. Every field is validated so the
// stored object stays small and can only hold the values the desktop understands.
const DESKTOP_STYLE_SCHEMA = {
  accent: v => /^#[0-9a-f]{6}$/i.test(v) ? v : undefined,
  wallpaperColor: v => /^#[0-9a-f]{6}$/i.test(v) ? v : undefined,
  wallpaperMode: v => ["image", "color", "gradient"].includes(v) ? v : undefined,
  gradient: v => ["aurora", "sunset", "ocean", "forest", "candy", "midnight"].includes(v) ? v : undefined,
  fit: v => ["cover", "contain", "stretch", "center", "tile"].includes(v) ? v : undefined,
  uiFont: v => ["Poppins", "Inter", "Nunito", "Roboto Slab", "Lora", "JetBrains Mono", "system-ui"].includes(v) ? v : undefined,
  brightness: v => clampNumber(v, 30, 130), saturation: v => clampNumber(v, 0, 200), blur: v => clampNumber(v, 0, 30),
  radius: v => clampNumber(v, 0, 28), glass: v => clampNumber(v, 30, 100), iconScale: v => clampNumber(v, 70, 150),
  nightWarmth: v => clampNumber(v, 10, 60),
  nightSchedule: v => ["off", "sunset", "custom"].includes(v) ? v : undefined,
  nightFrom: v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined,
  nightTo: v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined
};
function clampNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}
app.post("/api/desktop-style", (req, res) => {
  const style = {};
  for (const [key, validate] of Object.entries(DESKTOP_STYLE_SCHEMA)) {
    const value = validate(req.body?.[key]);
    if (value !== undefined) style[key] = value;
  }
  // Personalisation is per account; the owner's stays where it always was.
  if (req.user && !req.user.owner) users.update(req.user.id, { desktopStyle: style });
  else { config.desktopStyle = style; saveConfig(); }
  res.json({ success: true, desktopStyle: style });
});

app.get("/get-settings", (req, res) => {
  const safe = { ...config };
  safe.hasPassword = !!config.passwordHash; // lets Settings ask for it before destructive actions
  // Third-party Store apps open from their own origin (see THIRD-PARTY APP ISOLATION).
  safe.appsOrigin = APPS_ORIGIN;
  if (Array.isArray(safe.installedApps)) {
    safe.installedApps = safe.installedApps.map(installed => isThirdPartyApp(installed)
      ? { ...installed, isolated: true, url: `${APPS_ORIGIN}/apps/${encodeURIComponent(installed.appId)}/index.html` }
      : installed);
  }
  delete safe.passwordHash;
  delete safe.users;
  if (safe.lastfm) safe.lastfm = { username: safe.lastfm.username }; // the API key stays server-side
  // Who is signed in; another account sees its own name and personalisation, not the owner's.
  safe.currentUser = req.user || users.toPublic(users.find(OWNER_ID));
  if (!safe.currentUser.owner) {
    const account = users.find(safe.currentUser.id);
    safe.username = account.username;
    delete safe.email;
    safe.desktopStyle = account.desktopStyle || {};
  }
  res.json(safe);
});

// SECURITY (C-03): this route is an allowlist, not a denylist. It previously
// copied ANY field that was not explicitly protected into config.json, which let
// an unauthenticated caller flip security flags such as `allowFlashing` or
// `frpLock` and unlock the command-execution routes. Only user-facing preferences
// may be written here; everything else is ignored.
const SAVE_SETTINGS_ALLOWED = new Set([
  "darkMode", "performance", "animations", "developer",
  "sendReports", "wallpaper", "theme", "accentColor", "language"
]);
app.post("/save-settings", (req, res) => {
  const { username, email, ...extra } = req.body;
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
    if (key === "language" && !isAvailableLanguage(extra[key])) return;
    if (SAVE_SETTINGS_ALLOWED.has(key)) config[key] = extra[key];
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
    const ok = await comparePassword(currentPassword, config.passwordHash);
    if (!ok) return res.status(401).send("Current password is incorrect.");
  }
  config.username = username;
  config.passwordHash = await bcrypt.hash(newPassword, 10);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  issueSession(res); // A-02: the user who just set the password is now authenticated.
  res.send("Configurazione completata!");
});

app.post("/clear-password", async (req, res) => {
  if (config.passwordHash) {
    const { currentPassword } = req.body;
    const ok = await comparePassword(currentPassword, config.passwordHash);
    if (!ok) return res.status(401).send("Current password is incorrect.");
  }
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  clearSession(res);
  res.send("Password cleared! You can now log in without a password.");
});

// --- ACCOUNTS (lib/users.js) ---
// The login screen lists accounts before anyone signs in, like any desktop OS.
app.get("/api/users/login-list", (req, res) => {
  if (!config.passwordHash) return res.json({ success: true, users: [] });
  res.json({ success: true, users: users.all().map(users.toPublic) });
});
app.get("/api/users/me", (req, res) => res.json({ success: true, user: req.user }));
// The same, as a script pages load before their own: what they keep in the browser's
// storage (recent files, history, tabs) is kept apart per account from the first line.
app.get("/api/users/me.js", (req, res) => {
  res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
  const user = req.user || {};
  const data = JSON.stringify({ id: user.id || OWNER_ID, owner: user.owner !== false, admin: user.admin !== false }).replace(/</g, "\\u003c");
  res.send(`window.mariowOSUser = ${data};
window.mariowOSUserKey = key => window.mariowOSUser.owner ? key : key + "@" + window.mariowOSUser.id;
`);
});
app.get("/api/users", requireAuthJson, (req, res) => res.json({ success: true, users: users.all().map(users.toPublic), me: req.user }));
app.get("/api/users/avatar/:id", (req, res) => {
  const account = req.params.id === "me" ? users.find(req.user?.id) : users.find(req.params.id);
  const file = account && users.avatarOf(account);
  res.set("Cache-Control", "no-store");
  res.sendFile(file && fs.existsSync(file) ? file : path.join(__dirname, "desktop", "assets", "avatar.png"));
});
app.post("/api/users/create", async (req, res) => {
  const named = users.validateName(req.body?.username);
  if (named.error) return res.status(400).json({ success: false, error: named.error });
  const password = String(req.body?.password || "");
  if (password.length < 4) return res.status(400).json({ success: false, error: "Use a password of at least 4 characters." });
  const user = users.create({ username: named.name, passwordHash: await bcrypt.hash(password, 10), admin: !!req.body?.admin });
  res.json({ success: true, user });
});
app.post("/api/users/update", (req, res) => {
  const account = users.find(req.body?.id);
  if (!account) return res.status(404).json({ success: false, error: "Unknown account." });
  if (account.owner) return res.status(403).json({ success: false, error: "The owner account is always an administrator. Change its name from your account page." });
  const patch = {};
  if (req.body.username !== undefined) {
    const named = users.validateName(req.body.username, account.id);
    if (named.error) return res.status(400).json({ success: false, error: named.error });
    patch.username = named.name;
  }
  if (req.body.admin !== undefined) {
    if (!req.body.admin && account.admin && users.adminCount() <= 1) return res.status(400).json({ success: false, error: "Keep at least one administrator." });
    patch.admin = !!req.body.admin;
  }
  res.json({ success: true, user: users.update(account.id, patch) });
});
app.post("/api/users/reset-password", async (req, res) => {
  const account = users.find(req.body?.id);
  if (!account || account.owner) return res.status(400).json({ success: false, error: "Change the owner's password from its own account." });
  const password = String(req.body?.password || "");
  if (password.length < 4) return res.status(400).json({ success: false, error: "Use a password of at least 4 characters." });
  users.update(account.id, { passwordHash: await bcrypt.hash(password, 10) });
  res.json({ success: true });
});
// Anyone can change their own password, knowing the current one.
app.post("/api/users/password", async (req, res) => {
  const account = users.find(req.user?.id);
  if (!account) return res.status(401).json({ success: false, error: "Sign in first." });
  if (passwordLockSeconds() > 0) return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${passwordLockSeconds()} seconds.` });
  if (!(await comparePassword(String(req.body?.currentPassword || ""), account.passwordHash))) return res.status(403).json({ success: false, error: "Your current password is not correct." });
  const password = String(req.body?.newPassword || "");
  if (password.length < 4) return res.status(400).json({ success: false, error: "Use a password of at least 4 characters." });
  const hash = await bcrypt.hash(password, 10);
  if (account.owner) { config.passwordHash = hash; saveConfig(); } else users.update(account.id, { passwordHash: hash });
  res.json({ success: true });
});
app.post("/api/users/delete", (req, res) => {
  const account = users.find(req.body?.id);
  if (!account) return res.status(404).json({ success: false, error: "Unknown account." });
  if (account.owner) return res.status(403).json({ success: false, error: "The owner account cannot be removed." });
  if (account.id === req.user?.id) return res.status(400).json({ success: false, error: "You cannot remove the account you are using." });
  users.remove(account.id, { deleteFiles: !!req.body?.deleteFiles });
  res.json({ success: true });
});

// A-02: explicit logout so the desktop can drop the session on sign-out / lock.
app.post("/api/system/logout", (req, res) => {
  clearSession(res);
  res.json({ success: true });
});

// SECURITY (D-03): per-app tokens are ACCOUNTABILITY, NOT ISOLATION. Apps run as
// same-origin iframes, so any app can POST here asking for ANY appId's token (there is
// no un-spoofable way, over same-origin HTTP, to prove which app is calling). Treat
// `enforceAppPermissions` as "which app is *supposed* to own this endpoint" for logging
// and least-privilege-by-convention — never as a trust boundary against a malicious
// app. Anything that must be safe against a rogue app is instead gated by the account
// PASSWORD at the route itself (see /api/remote/exec, /api/recovery/debug,
// /api/system/factory-reset, /api/system/restore, /clear-password). A real boundary
// would require serving each app from its own origin/partition and binding the token
// to the un-spoofable Origin header — a separate, larger change.
app.post("/api/app/token", (req, res) => {
  const appId = req.body && req.body.appId;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: "Invalid app ID" });
  res.json({ success: true, token: signAppToken(appId) });
});


app.post("/api/system/factory-reset", async (req, res) => {
  // SECURITY (D-02): a factory reset is irreversible (wipes installed apps, assets and
  // the whole config, and clears the password). A valid session alone is not enough —
  // a hijacked session or a rogue same-origin app must not be able to trigger it. Re-
  // confirm the account password. When no password is configured there is nothing to
  // protect, so the fresh-install / post-reset path still works with no password.
  if (config.passwordHash) {
    const password = String((req.body && req.body.password) || "");
    if (!password) {
      return res.status(403).json({ success: false, code: "PASSWORD_REQUIRED",
        error: "Enter your account password to confirm the factory reset." });
    }
    if (passwordLockSeconds() > 0) {
      return res.status(429).json({ success: false, code: "PASSWORD_LOCKED",
        error: `Too many wrong password attempts. Try again in ${passwordLockSeconds()} seconds.` });
    }
    const ok = await comparePassword(password, config.passwordHash);
    if (!ok) return res.status(403).json({ success: false, code: "WRONG_PASSWORD",
      error: "Incorrect password. Nothing was erased." });
  }
  const errors = [];
  const removePath = target => {
    try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); }
    catch (e) { errors.push(path.basename(target) + ": " + e.message); }
  };
  removePath(path.join(__dirname, "spotify-token.json"));
  removePath(users.homesDir);

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

// Version-aware upgrade check. For each installed app we compare the version it was
// installed with against the version declared in its repo's version.json (the app
// author's own file, on their git). An app is upgradable only when the repo declares
// a strictly NEWER semantic version — the same rule the system updater uses.
app.get("/api/store/check-upgrades", async (req, res) => {
  const installedApps = config.installedApps || [];
  const upgrades = [];
  for (const app of installedApps) {
    const targetPath = path.join(__dirname, "desktop/apps", app.appId);
    if (!fs.existsSync(targetPath) || !isAllowedRepoUrl(app.repoUrl)) continue;
    const current = app.version || readInstalledAppVersion(app.appId);
    const latest = await fetchRepoVersion(app.repoUrl);
    if (latest && (!current || isNewerVersion(latest, current))) {
      upgrades.push({ appId: app.appId, title: app.title, current: current || "unknown", latest });
    }
  }
  res.json({ success: true, upgrades });
});

// Apply upgrades. Only apps that are git clones from an allowed repo and that actually
// declare a newer version.json are pulled; the recorded version is then refreshed.
app.post("/api/store/do-upgrade", async (req, res) => {
  const installedApps = config.installedApps || [];
  let count = 0;
  const updated = [];
  for (const app of installedApps) {
    const targetPath = path.join(__dirname, "desktop/apps", app.appId);
    if (!fs.existsSync(path.join(targetPath, ".git")) || !isAllowedRepoUrl(app.repoUrl)) continue;
    const current = app.version || readInstalledAppVersion(app.appId);
    const latest = await fetchRepoVersion(app.repoUrl);
    if (!latest || (current && !isNewerVersion(latest, current))) continue;

    const pulled = await new Promise(resolve => {
      // Pull from the pinned origin only; never a URL taken from the request body.
      const child = spawn("git", ["pull", "--ff-only"], { cwd: targetPath });
      child.on("error", () => resolve(false));
      child.on("close", code => resolve(code === 0));
    });
    if (pulled) {
      count++;
      app.version = readInstalledAppVersion(app.appId) || latest;
      updated.push({ appId: app.appId, version: app.version });
    }
  }
  if (count > 0) fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, count, updated });
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
  // SECURITY (A-07 adjacent): only install from an https github.com URL.
  if (!isAllowedRepoUrl(repoUrl)) {
    return res.status(400).json({ success: false, error: "Only https github.com repository URLs are allowed." });
  }

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
    // Record repoUrl + installed version so the store can offer version.json-based
    // upgrades later (see /api/store/check-upgrades).
    const installedVersion = readInstalledAppVersion(appId);
    // Tiles is a desktop, not an app: it lives in desktop/ only, never in desktop/apps.
    if (appId === "tiles") fs.rmSync(absolutePath, { recursive: true, force: true });
    const existing = config.installedApps.find(app => app.appId === appId);
    if (existing) {
      existing.repoUrl = repoUrl;
      if (installedVersion) existing.version = installedVersion;
    } else {
      config.installedApps.push({ appId, title, icon: localIconPath, url: relativeUrl, repoUrl, version: installedVersion || null });
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
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
// A real calendar date (rejects 2026-02-31, 2026-13-01…).
const isRealDate = value => {
  if (!DATE_RE.test(value || "")) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
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
  // Repeat every N days/weeks/months/years, optionally until a date, minus skipped occurrences.
  if (input.interval !== undefined) { const n = Math.round(Number(input.interval)); ev.interval = n >= 1 && n <= 99 ? n : 1; }
  if (input.until !== undefined) ev.until = input.until ? String(input.until) : "";
  if (input.exdates !== undefined) ev.exdates = Array.isArray(input.exdates) ? [...new Set(input.exdates.map(String).filter(isRealDate))].slice(0, 500) : [];

  if (!ev.title) return { error: "Title is required." };
  if (!isRealDate(ev.date)) return { error: "Invalid date." };
  if (ev.endDate && (!isRealDate(ev.endDate) || ev.endDate < ev.date)) return { error: "End date must be after the start date." };
  if (ev.until && (!isRealDate(ev.until) || ev.until < ev.date)) return { error: "The repeat end date must be after the start date." };
  if (!ev.allDay) {
    if (!TIME_RE.test(ev.start || "")) return { error: "Invalid start time." };
    if (ev.end && !TIME_RE.test(ev.end)) return { error: "Invalid end time." };
    if (ev.end && (!ev.endDate || ev.endDate === ev.date) && ev.end < ev.start) return { error: "End time must be after the start time." };
  } else {
    ev.start = ""; ev.end = "";
  }
  ev.color = ev.color || "blue";
  ev.repeat = ev.repeat || "none";
  if (ev.repeat === "none") { delete ev.interval; delete ev.until; delete ev.exdates; }
  else ev.interval = ev.interval || 1;
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
const icsEscape = s => String(s || "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
// RFC 5545 line folding at 75 octets, never splitting a UTF-8 character.
function icsFold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let chunk = "", limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(chunk + ch) > limit) { out.push(chunk); chunk = ""; limit = 74; }
    chunk += ch;
  }
  out.push(chunk);
  return out.join("\r\n ");
}
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
    if (ev.repeat && ev.repeat !== "none") {
      let rule = `RRULE:FREQ=${ev.repeat.toUpperCase()}`;
      if (ev.interval > 1) rule += `;INTERVAL=${ev.interval}`;
      if (ev.until) rule += `;UNTIL=${compactDate(ev.until)}${ev.allDay ? "" : "T235959"}`;
      lines.push(rule);
      for (const ex of ev.exdates || []) {
        lines.push(ev.allDay ? `EXDATE;VALUE=DATE:${compactDate(ex)}` : `EXDATE:${compactDate(ex)}T${ev.start.replace(":", "")}00`);
      }
    }
    if (ev.reminder >= 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${ev.reminder}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="mariowOS-calendar.ics"');
  res.send(lines.map(icsFold).join("\r\n") + "\r\n");
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
  // Events made here are exported as "<id>@mariowos": treat those as already present too.
  const existingUids = new Set(config.calendarEvents.flatMap(e => [e.uid, e.id + "@mariowos"]).filter(Boolean));
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
    else if (key === "RRULE") {
      const f = value.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i);
      if (f) current.repeat = f[1].toLowerCase();
      const interval = value.match(/INTERVAL=(\d+)/i);
      if (interval) current.interval = Number(interval[1]);
      const until = value.match(/UNTIL=(\d{4})(\d{2})(\d{2})/i);
      if (until) current.until = `${until[1]}-${until[2]}-${until[3]}`;
      const count = value.match(/COUNT=(\d+)/i);
      if (count) current.count = Number(count[1]);
    }
    else if (key === "EXDATE") {
      current.exdates = current.exdates || [];
      value.split(",").forEach(v => { const m = v.match(/^(\d{4})(\d{2})(\d{2})/); if (m) current.exdates.push(`${m[1]}-${m[2]}-${m[3]}`); });
    }
    else if (key === "END" && value === "VEVENT") {
      const c = current; current = null;
      if (!c.dtstart || (c.uid && existingUids.has(c.uid))) { skipped++; continue; }
      const input = { title: c.title || "(No title)", notes: c.notes || "", location: c.location || "", date: c.dtstart.date, allDay: c.dtstart.allDay, repeat: c.repeat || "none" };
      if (c.repeat) {
        input.interval = c.interval || 1;
        if (c.until) input.until = c.until;
        else if (c.count) {
          // COUNT → last occurrence date.
          const steps = (c.count - 1) * (c.interval || 1);
          const d = new Date(c.dtstart.date + "T00:00:00Z");
          if (c.repeat === "daily") d.setUTCDate(d.getUTCDate() + steps);
          else if (c.repeat === "weekly") d.setUTCDate(d.getUTCDate() + steps * 7);
          else if (c.repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + steps);
          else d.setUTCFullYear(d.getUTCFullYear() + steps);
          input.until = d.toISOString().slice(0, 10);
        }
        if (c.exdates) input.exdates = c.exdates;
      }
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
      // SECURITY (A-06): disabled. This ran an arbitrary shell command stored in a
      // rule, which gave anyone who could save a rule a persistent, cron-triggered
      // code-execution foothold. Automation actions must come from the fixed set
      // handled by the other cases; free-form commands are not allowed.
      console.warn("Rule action 'run' is disabled for security reasons and was ignored.");
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
// SECURITY (C-06): vmId is used to build filesystem paths and then code is executed
// from the resulting directory. Without validation a value like "../../.." escapes
// the sandbox. Allow only simple identifiers; reject everything else.
function isValidVmId(vmId) {
  return typeof vmId === 'string' && /^[a-zA-Z0-9_-]+$/.test(vmId);
}
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
  limits: { fileSize: 512 * 1024 * 1024 }, // M-04: VM disk images are large but not unbounded
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
  if (!isValidVmId(vmId)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: "Valid Virtual Machine ID is required." });
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
  if (!isValidVmId(vmId)) return res.status(400).json({ success: false, error: "Invalid VM ID." });

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
  if (!isValidVmId(vmId)) return res.status(400).json({ success: false, error: "Invalid VM ID." });

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

const { matchesGitBlob, validateStagedRuntime, verifyReleaseSignature } = require("./lib/update-checks");

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

// Local/runtime files that an update must never overwrite (they may also be locked on Windows, e.g. the open log)
const UPDATE_PROTECTED_FILES = new Set(["config.json", "keys.json", "session.key", "spotify-token.json", ".env", "boot-mode.json"]);
function isUpdateProtectedFile(relativePath) {
  return /\.log$/i.test(relativePath) || UPDATE_PROTECTED_FILES.has(relativePath);
}

function applyStagedFiles(files, send, initialPercent, finalPercent) {
  const applied = [];
  const createdDirectories = [];
  const regularFiles = files.filter(file => file.relativePath !== "server.js" && !isUpdateProtectedFile(file.relativePath));

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
const BUILD_ROOTS = ["server.js", "launcher.js", "preload.js", "boot.html", "desktop", "loginui", "lockscreen", "recovery"];
const BUILD_SKIP_NAMES = new Set(["node_modules", "config.json", "keys.json", "spotify-token.json", "sota-installed.json", "mail-error.log", ".env"]);
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
      
    const channel = getUpdateChannel();
    const remoteUrl = `https://raw.githubusercontent.com/mariowOS/${channel}/main/version.json?t=${Date.now()}`; 
    const response = await fetch(remoteUrl);
    
    if (!response.ok) {
       return res.json({ updateAvailable: false, current: local, error: "Server unreachable (404/500)" });
    }
    
    const remote = await response.json();
    // A release the launcher had to roll back is not offered again: the next fixed
    // release will carry a different version number.
    const rollback = readRollbackPoint(__dirname);
    if (rollback && rollback.rolledBack && rollback.toVersion && rollback.toVersion === remote.version) {
      return res.json({ updateAvailable: false, current: local, latest: remote.version, blocked: true,
        error: `Version ${remote.version} was rolled back because it did not start. Waiting for a fixed release.` });
    }
    res.json(
      isNewerVersion(remote.version, local)
        ? { updateAvailable: true, current: local, latest: remote.version, changelog: remote.changelog }
        : { updateAvailable: false, current: local, latest: remote.version }
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
  // SECURITY (A-05): no wildcard CORS. These SSE update streams are for the local UI only.

  const send = (percent, status, finished = false) => {
    const msg = `data: ${JSON.stringify({ percent, status, finished })}\n\n`;
    try { res.write(msg); } catch (e) {}
  };

  const stagePath = path.join(os.tmpdir(), `mariowos-update-${process.pid}-${Date.now()}`);
  send(0, "Preparing update...");
  (async () => {
    try {
      const channel = getUpdateChannel();

      send(5, "Downloading complete update...");
      await runGit(["clone", "--quiet", "--depth", "1", "--branch", "main", `https://github.com/mariowOS/${channel}.git`, stagePath], os.tmpdir());
      send(70, "Checking every downloaded file...");
      const files = await getStagedUpdateFiles(stagePath);
      if (files.length === 0) throw new Error("The update contains no files");
      // A-07: with a public key installed, only a release signed by the maintainer is applied.
      const publicKey = getUpdatePublicKey();
      if (publicKey) {
        send(72, "Verifying the release signature...");
        const auth = verifyReleaseSignature(stagePath, files, publicKey);
        if (!auth.ok) throw new Error("Update rejected: " + auth.reason);
      } else {
        console.warn("[update] No update-pubkey.pem configured: this update is NOT signature-verified.");
      }
      const serverUpdate = files.find(file => file.relativePath === "server.js");
      if (serverUpdate) await validateStagedServer(serverUpdate.stagedFile);
      validateStagedRuntime(stagePath, files, __dirname);
      // Keep the files this update replaces: if the new kernel keeps crashing, the
      // launcher puts them back (lib/rollback.js) instead of leaving a boot loop.
      send(74, "Saving a restore point...");
      createRollbackPoint(__dirname, files, {
        toVersion: readStagedVersion(stagePath),
        isProtected: isUpdateProtectedFile,
        isUnchanged: (contents, file) => matchesGitBlob(contents, file.blobHash)
      });
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
      .filter(name => isNewerVersion(latest[name], current[name]))
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
  // SECURITY (A-05): no wildcard CORS. These SSE update streams are for the local UI only.

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
      const changedComponents = [...SOTA_COMPONENTS].filter(name => isNewerVersion(latest[name], current[name]));

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
    CPU: `${cpus[0].model}`, RAM: `${Math.round(os.totalmem() / 1048576)} MB`,
    FreeRAM: `${Math.round(os.freemem() / 1048576)} MB`, Cores: cpus.length, Platform: `${os.platform()} ${os.arch()}`
  });
});

// --- KEYRING ---
// The Terminal's addkey / delkey / listkeys commands. Keys are opaque strings the user
// wants the system to remember, kept in keys.json as [{ key, date }] — the file the
// recovery wipe and factory reset already empty and the updater never overwrites.
const keyringFile = path.join(__dirname, "keys.json");
const KEYRING_MAX = 200;
function readKeyring() {
  try {
    const keys = JSON.parse(fs.readFileSync(keyringFile, "utf8"));
    return Array.isArray(keys) ? keys.filter(entry => entry && typeof entry.key === "string") : [];
  } catch (error) { return []; }
}
function writeKeyring(keys) {
  fs.writeFileSync(keyringFile, JSON.stringify(keys, null, 2));
}
function cleanKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return key && key.length <= 512 && !/[\x00-\x1f]/.test(key) ? key : null;
}
app.get("/api/system/keyring", requireAuthJson, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, keys: readKeyring() });
});
app.post("/api/system/keyring", requireAuthJson, (req, res) => {
  const key = cleanKey(req.body?.key);
  if (!key) return res.status(400).json({ success: false, error: "Invalid key (1-512 printable characters)." });
  const keys = readKeyring();
  if (keys.some(entry => entry.key === key)) return res.status(409).json({ success: false, error: "Key already in the keyring." });
  if (keys.length >= KEYRING_MAX) return res.status(400).json({ success: false, error: `The keyring is full (${KEYRING_MAX} keys).` });
  keys.push({ key, date: new Date().toISOString() });
  writeKeyring(keys);
  res.json({ success: true });
});
app.post("/api/system/keyring/delete", requireAuthJson, (req, res) => {
  const key = cleanKey(req.body?.key);
  const keys = readKeyring();
  if (!key || !keys.some(entry => entry.key === key)) return res.status(404).json({ success: false, error: "Key not found." });
  writeKeyring(keys.filter(entry => entry.key !== key));
  res.json({ success: true });
});

// --- MUSIC LIBRARY ---
// The Music app plays three kinds of source: files the user imported into the app
// itself, audio sitting in their Home folder, and curated internet stations. This
// endpoint covers the middle one, so dropping a file in Home/Music is enough to
// make it playable with no import step.
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus", ".weba", ".webm"]);
// The signed-in account's own Music folder (lib/users.js).
const MUSIC_LIBRARY_DIRECTORIES = [
  { virtual: "/home/Music", dir: () => path.join(users.homeOf(users.current()), "Music"), url: "/api/music/file?name=" }
];

function readMusicLibrary() {
  const tracks = [];
  for (const source of MUSIC_LIBRARY_DIRECTORIES) {
    const directory = source.dir();
    try {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        let bytes = 0;
        try { bytes = fs.statSync(path.join(directory, entry.name)).size; } catch (error) {}
        tracks.push({ name: entry.name, url: source.url + encodeURIComponent(entry.name), bytes });
      }
    } catch (error) {
      console.error("Could not read the music library:", error);
    }
  }
  return tracks.sort((a, b) => a.name.localeCompare(b.name));
}

app.get("/api/music/library", requireAuthJson, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, tracks: readMusicLibrary() });
});

// Streams one file out of Home/Music. The name is matched against the directory
// listing rather than joined blindly, so no traversal can reach another folder.
app.get("/api/music/file", requireAuthJson, (req, res) => {
  const requested = typeof req.query.name === "string" ? req.query.name : "";
  const directory = path.join(users.homeOf(users.current()), "Music");
  const match = readMusicLibrary().find(track => track.name === requested);
  if (!match) return res.status(404).json({ success: false, error: "Track not found" });
  res.sendFile(path.join(directory, match.name));
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

// Each account has its own notes (lib/users.js).
const notesFileNow = () => users.notesFileOf(users.current());
const NOTE_FIELDS = ["id", "name", "content", "color", "pinned", "createdAt", "updatedAt", "deletedAt",
  "sourcePath", "sourceName", "sourceFormat", "sourceTemplate"];
app.get("/api/system/notes", requireAuthJson, (req, res) => {
  const notesFile = notesFileNow();
  if (fs.existsSync(notesFile)) {
    try { res.json(JSON.parse(fs.readFileSync(notesFile, "utf8"))); } catch (e) { res.json([]); }
  } else { res.json([]); }
});

app.post("/api/system/notes", requireAuthJson, express.json({ limit: "25mb" }), (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ success: false, error: "Expected a list of notes." });
  // Keep only known fields with the expected types.
  const clean = req.body
    .filter(note => note && typeof note === "object" && typeof note.id === "string" && note.id.length <= 64)
    .map(note => {
      const out = {};
      for (const key of NOTE_FIELDS) {
        const value = note[key];
        if (value === undefined || value === null) continue;
        if (key === "pinned") out[key] = Boolean(value);
        else if (["createdAt", "updatedAt", "deletedAt"].includes(key)) { if (Number.isFinite(value)) out[key] = value; }
        else if (typeof value === "string") out[key] = value;
      }
      return out;
    });
  // Write to a temporary file first, so a crash never leaves a half-written database.
  const notesFile = notesFileNow();
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  const temporary = `${notesFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(clean));
    fs.renameSync(temporary, notesFile);
    res.json({ success: true });
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (e) {}
    console.error("Could not save notes:", error);
    res.status(500).json({ success: false, error: "Could not save notes." });
  }
});

// --- PASSWORD VERIFICATION ---
app.post("/api/system/verify-password", async (req, res) => {
  const { password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  if (!currentConfig.passwordHash) return res.json({ success: true });
  // Confirms the signed-in account's own password (the lock screen, Settings prompts).
  const account = users.find(req.user?.id) || users.find(OWNER_ID);
  const match = await comparePassword(password, account.passwordHash);
  res.json({ success: match });
});

// --- REMOTE EXECUTION ---
app.post("/api/remote/exec", (req, res) => {
  const { command, password } = req.body;
  const currentConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  
  // SECURITY (C-02): fail closed. Previously the guard was
  // `if (!match && currentConfig.passwordHash)`, so when no password was set
  // (first boot, after a reset, or after /clear-password) the command ran with no
  // authentication at all. Now: no password configured => refuse outright, and a
  // wrong password => refuse. A command only runs on a verified match.
  if (!currentConfig.passwordHash) {
    return res.status(403).json({ success: false, error: "Remote execution is disabled: no password is configured." });
  }
  comparePassword(password || "", currentConfig.passwordHash).then(match => {
    if (!match) {
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

// "/device" is the window onto the machine mariowOS is running on. Everything below
// it mirrors the host filesystem exactly as the OS lays it out: drive letters on
// Windows, the single "/" tree on macOS and Linux. It is always read-only, so the
// desktop can show the real hierarchy without ever being able to damage the host.
const DEVICE_ROOT = '/device';

function listHostVolumes() {
  if (currentOS !== 'win32') return [{ name: '/', realPath: path.sep }];

  const volumes = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    const realPath = letter + ':' + path.sep;
    try {
      if (fs.existsSync(realPath)) volumes.push({ name: letter + ':', realPath });
    } catch (error) {
      // An unreadable or disconnected drive simply does not appear.
    }
  }
  return volumes;
}

function resolveDevicePath(virtualPath) {
  const relative = virtualPath.slice(DEVICE_ROOT.length).replace(/^\//, '');
  if (!relative) return { realPath: null, isReadOnly: true, isVolumeList: true };

  if (currentOS !== 'win32') {
    return { realPath: path.resolve('/', relative), isReadOnly: true };
  }

  const [volume, ...rest] = relative.split('/');
  if (!/^[A-Za-z]:$/.test(volume)) return null;
  const volumeRoot = volume.toUpperCase() + path.sep;
  const realPath = path.resolve(volumeRoot, ...rest);
  // path.resolve starting from a drive letter can hop to another volume; pin it down.
  if (path.parse(realPath).root.toUpperCase() !== volumeRoot) return null;
  return { realPath, isReadOnly: true };
}

function resolveVirtualPath(targetPath) {
  const requestedPath = typeof targetPath === 'string' && targetPath ? targetPath : '/home';
  const virtualPath = path.posix.normalize(requestedPath.replace(/\\/g, '/'));
  if (!virtualPath.startsWith('/')) return null;

  const user = users.current();
  const isHome = virtualPath === '/home' || virtualPath.startsWith('/home/');
  // A standard account only ever sees its own home.
  if (!isHome && !user.admin) return null;

  if (virtualPath === DEVICE_ROOT || virtualPath.startsWith(DEVICE_ROOT + '/')) {
    return resolveDevicePath(virtualPath);
  }

  // "/home" is the signed-in user's own folder (lib/users.js).
  const rootPath = isHome ? path.resolve(users.homeOf(user)) : path.resolve(__dirname);
  const subPath = isHome ? virtualPath.slice('/home'.length) : virtualPath.slice(1);
  const realPath = path.resolve(rootPath, `.${subPath}`);
  if (realPath !== rootPath && !realPath.startsWith(`${rootPath}${path.sep}`)) return null;
  // Browsing the system tree never leads into someone else's home.
  const inside = dir => realPath === dir || realPath.startsWith(dir + path.sep);
  if (!isHome && (inside(path.resolve(users.homesDir)) || (user.id !== OWNER_ID && inside(path.resolve(users.homeOf(null)))))) return null;

  return { realPath, isReadOnly: !isHome };
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

// Real device directories hold entries this process may not be allowed to stat
// (locked system files, offline network shares). One of those must not take down
// the whole listing, so every entry is described on a best-effort basis.
function describeEntry(parentPath, entry) {
  const isDirectory = entry.isDirectory();
  const described = {
    name: entry.name,
    type: isDirectory ? 'folder' : 'file',
    ext: path.extname(entry.name).toLowerCase(),
    size: '--',
    bytes: -1,
    date: '--'
  };
  try {
    const stats = fs.statSync(path.join(parentPath, entry.name));
    described.date = stats.mtime.toLocaleDateString();
    described.mtime = stats.mtimeMs;
    if (!isDirectory) {
      described.bytes = stats.size;
      described.size = formatFileSize(stats.size);
    }
  } catch (error) {
    // Keep the placeholders: the entry is still worth showing in the hierarchy.
  }
  return described;
}

app.get("/api/system/files", requireAuthJson, (req, res) => {
  const targetPath = req.query.path || '/home';
  const resolved = resolveVirtualPath(targetPath);

  if (!resolved) return res.status(403).json({ success: false, error: "Access denied" });

  // The device root is not a directory on disk: it is the list of mounted volumes.
  if (resolved.isVolumeList) {
    const contents = listHostVolumes().map(volume => {
      let date = '--';
      try { date = fs.statSync(volume.realPath).mtime.toLocaleDateString(); } catch (error) {}
      return { name: volume.name, type: 'folder', ext: '', size: '--', bytes: -1, date, isVolume: true };
    });
    return res.json({ success: true, contents, isReadOnly: true });
  }

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
    const contents = items.map(item => describeEntry(resolved.realPath, item));

    contents.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'folder' ? -1 : 1;
    });

    res.json({ success: true, contents, isReadOnly: resolved.isReadOnly });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// One rule for every file or folder name coming from a client: a single path segment.
function validEntryName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name === "." || name === ".." || name.length > 255) return null;
  if (/[\\/\x00-\x1f]/.test(name)) return null;
  if (process.platform === "win32" && /[<>:"|?*]/.test(name)) return null;
  return name;
}
// Resolve "<virtual dir>/<name>" inside the writable home area, or null.
function resolveHomeEntry(dirPath, name) {
  const resolved = resolveVirtualPath(dirPath);
  const clean = validEntryName(name);
  if (!resolved || resolved.isReadOnly || resolved.isVolumeList || !clean) return null;
  const full = path.join(resolved.realPath, clean);
  const homeRoot = path.resolve(users.homeOf(users.current()));
  if (!full.startsWith(homeRoot + path.sep)) return null;
  return { dir: resolved.realPath, full, name: clean };
}
// "report.txt" → "report (2).txt" until free.
function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} (${i})${ext && ext !== name ? ext : ""}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

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

  // SECURITY: both names must be single path segments, otherwise "../x" could move files
  // into or out of the home area.
  const oldName = validEntryName(req.body.oldName);
  const newName = validEntryName(req.body.newName);
  if (!oldName || !newName) return res.status(400).json({ success: false, error: "Invalid name" });

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

// Legacy JSON/base64 upload (used by the desktop). SECURITY: the name is validated, so it
// can no longer write outside the target folder.
app.post("/api/system/files/upload", express.json({ limit: "200mb" }), (req, res) => {
  const target = resolveHomeEntry(req.body?.path, req.body?.name);
  if (!target) return res.status(400).json({ success: false, error: "Invalid destination or file name" });
  if (typeof req.body.data !== "string") return res.status(400).json({ success: false, error: "Missing file data" });
  try {
    const base64 = req.body.data.includes(",") ? req.body.data.slice(req.body.data.indexOf(",") + 1) : req.body.data;
    fs.writeFileSync(target.full, Buffer.from(base64, "base64"));
    res.json({ success: true, name: target.name });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Binary upload: body is the raw file. ?path=&name=&conflict=rename|replace|fail
app.post("/api/system/files/upload-raw", express.raw({ type: "*/*", limit: "2gb" }), (req, res) => {
  const target = resolveHomeEntry(req.query.path, req.query.name);
  if (!target) return res.status(400).json({ success: false, error: "Invalid destination or file name" });
  try {
    let name = target.name;
    if (fs.existsSync(target.full)) {
      if (req.query.conflict === "fail") return res.status(409).json({ success: false, error: "A file with this name already exists" });
      if (req.query.conflict !== "replace") name = uniqueName(target.dir, target.name);
      else if (fs.statSync(target.full).isDirectory()) return res.status(409).json({ success: false, error: "A folder with this name already exists" });
    }
    fs.writeFileSync(path.join(target.dir, name), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.json({ success: true, name });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Copy or move items between folders of the home area. Body: { fromPath, toPath, names[], mode: 'copy'|'move' }
app.post("/api/system/files/transfer", requireAuthJson, (req, res) => {
  const { fromPath, toPath, names, mode } = req.body || {};
  if (!Array.isArray(names) || !names.length || !["copy", "move"].includes(mode)) {
    return res.status(400).json({ success: false, error: "Nothing to copy or move" });
  }
  const destination = resolveVirtualPath(toPath);
  if (!destination || destination.isReadOnly || destination.isVolumeList) return res.status(403).json({ success: false, error: "The destination is read-only" });
  const results = [];
  for (const raw of names) {
    const source = resolveHomeEntry(fromPath, raw);
    if (!source || !fs.existsSync(source.full)) { results.push({ name: String(raw), error: "Not found" }); continue; }
    // A folder cannot go inside itself.
    if (destination.realPath === source.full || destination.realPath.startsWith(source.full + path.sep)) {
      results.push({ name: source.name, error: "A folder cannot be placed inside itself" }); continue;
    }
    try {
      const sameFolder = path.resolve(source.dir) === path.resolve(destination.realPath);
      if (mode === "move" && sameFolder) { results.push({ name: source.name, skipped: true }); continue; }
      const finalName = uniqueName(destination.realPath, source.name);
      const finalPath = path.join(destination.realPath, finalName);
      if (mode === "copy") fs.cpSync(source.full, finalPath, { recursive: true, errorOnExist: true });
      else {
        try { fs.renameSync(source.full, finalPath); }
        catch (error) {
          if (error.code !== "EXDEV") throw error;
          fs.cpSync(source.full, finalPath, { recursive: true });
          fs.rmSync(source.full, { recursive: true, force: true });
        }
      }
      results.push({ name: source.name, newName: finalName });
    } catch (e) { results.push({ name: source.name, error: e.message }); }
  }
  const failed = results.filter(r => r.error);
  res.status(failed.length === results.length ? 500 : 200).json({ success: failed.length === 0, results, error: failed[0]?.error });
});

// Stream a file of the home area for previews and downloads. ?path=&name=&download=1
const PREVIEW_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic", ".heif": "image/heif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ogv": "video/ogg", ".3gp": "video/3gpp",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8"
};
app.get("/api/system/files/raw", requireAuthJson, (req, res) => {
  const target = resolveHomeEntry(req.query.path, req.query.name);
  if (!target || !fs.existsSync(target.full) || fs.statSync(target.full).isDirectory()) {
    return res.status(404).json({ success: false, error: "File not found" });
  }
  const ext = path.extname(target.name).toLowerCase();
  // Only known media types render inline; HTML and unknown types are forced to download.
  // SVG is served inline as an image, but the sandbox CSP below disables any scripts it
  // carries (and the Pictures app loads it via <img>, where SVG scripts never run anyway).
  const inlineType = PREVIEW_TYPES[ext];
  res.setHeader("X-Content-Type-Options", "nosniff");
  // PDFs need the built-in viewer, which a sandbox CSP would block; everything else is locked down.
  if (ext !== ".pdf") res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  if (req.query.download === "1" || !inlineType) {
    return res.download(target.full, target.name);
  }
  res.type(inlineType);
  res.sendFile(target.full);
});

// Find files by name inside a home folder (recursive). ?path=&q=
app.get("/api/system/files/search", requireAuthJson, (req, res) => {
  const resolved = resolveVirtualPath(req.query.path || "/home");
  const query = String(req.query.q || "").trim().toLowerCase();
  if (!resolved || resolved.isReadOnly || resolved.isVolumeList) return res.status(403).json({ success: false, error: "Search works inside your home folders" });
  if (query.length < 1) return res.json({ success: true, results: [] });
  const homeRoot = path.resolve(users.homeOf(users.current()));
  const results = [];
  const walk = (dir, depth) => {
    if (results.length >= 300 || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(query)) {
        const rel = path.relative(homeRoot, dir).split(path.sep).filter(Boolean).join("/");
        results.push({ ...describeEntry(dir, entry), dir: "/home" + (rel ? "/" + rel : "") });
        if (results.length >= 300) return;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(resolved.realPath, 0);
  res.json({ success: true, results, truncated: results.length >= 300 });
});

// ── Trash: deleted items go to home/.Trash and can be restored ──
// Each account has its own trash, inside its home.
const trashDirNow = () => path.join(users.homeOf(users.current()), ".Trash");
const trashIndexNow = () => path.join(trashDirNow(), "index.json");
function readTrashIndex() {
  try { return JSON.parse(fs.readFileSync(trashIndexNow(), "utf8")); } catch (e) { return []; }
}
function writeTrashIndex(list) {
  fs.mkdirSync(trashDirNow(), { recursive: true });
  fs.writeFileSync(trashIndexNow(), JSON.stringify(list));
}
app.post("/api/system/files/trash", requireAuthJson, (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [req.body?.name];
  const index = readTrashIndex();
  const moved = [];
  try {
    fs.mkdirSync(trashDirNow(), { recursive: true });
    for (const raw of names) {
      const target = resolveHomeEntry(req.body?.path, raw);
      if (!target || !fs.existsSync(target.full) || target.full.startsWith(trashDirNow())) continue;
      const id = crypto.randomBytes(8).toString("hex");
      fs.renameSync(target.full, path.join(trashDirNow(), id));
      const virtualDir = path.posix.normalize(String(req.body.path).replace(/\\/g, "/"));
      index.push({ id, name: target.name, from: virtualDir, deletedAt: Date.now(), isFolder: fs.statSync(path.join(trashDirNow(), id)).isDirectory() });
      moved.push(target.name);
    }
    writeTrashIndex(index);
    res.json({ success: moved.length > 0, moved, error: moved.length ? undefined : "Nothing was moved to the trash" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get("/api/system/files/trash", requireAuthJson, (req, res) => {
  const index = readTrashIndex().filter(item => fs.existsSync(path.join(trashDirNow(), item.id)));
  res.json({ success: true, items: index.sort((a, b) => b.deletedAt - a.deletedAt) });
});
app.post("/api/system/files/trash/restore", requireAuthJson, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const index = readTrashIndex();
  const restored = [];
  for (const id of ids) {
    const item = index.find(i => i.id === id);
    if (!item || !/^[0-9a-f]{16}$/.test(id)) continue;
    let destination = resolveVirtualPath(item.from);
    if (!destination || destination.isReadOnly || !fs.existsSync(destination.realPath)) destination = resolveVirtualPath("/home");
    try {
      const finalName = uniqueName(destination.realPath, item.name);
      fs.renameSync(path.join(trashDirNow(), id), path.join(destination.realPath, finalName));
      index.splice(index.indexOf(item), 1);
      restored.push(finalName);
    } catch (e) {}
  }
  writeTrashIndex(index);
  res.json({ success: restored.length > 0, restored });
});
app.post("/api/system/files/trash/empty", requireAuthJson, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;   // null = everything
  const index = readTrashIndex();
  const keep = [];
  for (const item of index) {
    if (ids && !ids.includes(item.id)) { keep.push(item); continue; }
    try { fs.rmSync(path.join(trashDirNow(), item.id), { recursive: true, force: true }); } catch (e) { keep.push(item); }
  }
  writeTrashIndex(keep);
  res.json({ success: true });
});

app.get("/api/system/files/content", requireAuthJson, (req, res) => {
  const resolved = resolveVirtualPath(req.query.path);
  if (!resolved || !resolved.realPath) return res.status(403).json({ success: false, error: "Access denied" });
  // SECURITY (A-03): the /device tree mirrors the entire host filesystem. Listing it
  // is acceptable, but streaming the CONTENT of arbitrary host files over HTTP turns
  // this into a file-exfiltration endpoint (SSH keys, browser data, credentials).
  // Reading file content is limited to the mariowOS home area.
  if (resolved.isReadOnly) return res.status(403).json({ success: false, error: "Reading file content outside the home area is not allowed." });

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
    const fileName = validEntryName(req.body.name);
    if (!fileName) return res.status(400).json({ success: false, error: "Invalid file name" });
    const filePath = path.join(resolved.realPath, fileName);
    // "New file" must never empty an existing file with the same name.
    if (req.body.createOnly && fs.existsSync(filePath)) {
      return res.status(409).json({ success: false, error: "A file with this name already exists" });
    }
    fs.writeFileSync(filePath, typeof req.body.content === "string" ? req.body.content : "", "utf8");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// SECURITY (A-01): bind only to the loopback interface. The backend is a local
// companion to the Electron shell, not a network service. Binding to all
// interfaces previously exposed every API route to the whole LAN. A deployment
// that genuinely needs remote access must set MARIOWOS_BIND_HOST explicitly and
// is expected to add TLS + authentication in front of it.
const BIND_HOST = process.env.MARIOWOS_BIND_HOST || '127.0.0.1';
// Storage limitation (GDPR art. 5.1.e): error logs are deleted after 30 days and capped at 256 KB.
function pruneLogs() {
  const maxAge = 30 * 24 * 60 * 60 * 1000, maxSize = 256 * 1024;
  for (const name of ["mail-error.log", "update-error.log"]) {
    const file = path.join(__dirname, name);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > maxAge) fs.rmSync(file, { force: true });
      else if (stat.size > maxSize) fs.writeFileSync(file, fs.readFileSync(file).subarray(-maxSize));
    } catch (e) { if (e.code !== "ENOENT") console.error(`Could not prune ${name}:`, e); }
  }
}
pruneLogs();
cron.schedule("0 3 * * *", pruneLogs);

httpServer = app.listen(PORT, BIND_HOST, () => console.log(`kernel booted on [${currentOS}] at http://${BIND_HOST}:${PORT}`));

// Third-party Store apps (see THIRD-PARTY APP ISOLATION): static files only, on their
// own origin. Nothing here can reach the shell's API, cookies or storage.
const APP_SANDBOX_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  `frame-ancestors ${[...SHELL_ORIGINS].join(" ")}`
].join("; ");
const appsApp = express();
appsApp.disable("x-powered-by");
appsApp.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", APP_SANDBOX_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  next();
});
appsApp.use("/apps/:appId", (req, res, next) => {
  if (!thirdPartyAppIds().has(req.params.appId)) return res.status(404).end();
  express.static(path.join(__dirname, "desktop", "apps", req.params.appId), { dotfiles: "deny", fallthrough: false })(req, res, next);
});
// Shared fonts and icons, so apps can match the system look.
for (const shared of ["fonts", "icons"]) {
  appsApp.use(`/desktop/assets/${shared}`, express.static(path.join(__dirname, "desktop", "assets", shared), { fallthrough: false }));
}
appsApp.use((req, res) => res.status(404).end());
const appsServer = appsApp.listen(APPS_PORT, BIND_HOST);
appsServer.on("error", error => console.error("[apps] isolated app server could not start:", error.message));
httpServer.on('error', error => {
  console.error('kernel failed to bind its HTTP server:', error);
  process.exit(1);
});