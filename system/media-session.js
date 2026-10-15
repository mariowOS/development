// mariowOS - what is playing on this PC, via the Windows media session (SMTC).
// (C) 2026 mariowstech and the mariowOS team - Licensed under the Apache License, Version 2.0
//
// Works with the Spotify desktop app (and other players) without any account or API key,
// so it is the fallback when the Spotify Web API is unavailable (e.g. no Premium).
// A single PowerShell helper (tools/media-session.ps1) is kept alive and spoken to over
// stdin/stdout, one JSON line per command. Windows only.

const path = require("path");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "tools", "media-session.ps1");
const COMMAND_TIMEOUT_MS = 8000;
const IDLE_SHUTDOWN_MS = 2 * 60 * 1000;

let helper = null;
let buffer = "";
const waiting = [];   // resolvers, in command order
let idleTimer = null;

function stopHelper() {
  if (helper) helper.kill();
  helper = null;
}

function startHelper() {
  helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
  });
  buffer = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const next = waiting.shift();
      if (!next) continue;
      try { next.resolve(JSON.parse(line)); } catch (e) { next.resolve({ ok: false, error: "Bad response from media helper." }); }
    }
  });
  helper.on("exit", () => {
    helper = null;
    while (waiting.length) waiting.shift().resolve({ ok: false, error: "Media helper stopped." });
  });
}

function send(command) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, unsupported: true, error: "Only available on Windows." });
  if (!helper) startHelper();
  // Stop the helper when nobody has asked anything for a while.
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopHelper, IDLE_SHUTDOWN_MS);
  return new Promise(resolve => {
    const entry = { resolve };
    const timer = setTimeout(() => {
      // A stuck helper would desynchronise every later answer: restart it.
      stopHelper();
      resolve({ ok: false, error: "Media helper timed out." });
    }, COMMAND_TIMEOUT_MS);
    entry.resolve = value => { clearTimeout(timer); resolve(value); };
    waiting.push(entry);
    helper.stdin.write(command + "\n");
  });
}

function registerMediaSessionRoutes(app, { requireAuth }) {
  app.get("/api/media/session", requireAuth, async (req, res) => {
    const result = await send(req.query.any === "1" ? "any:get" : "get");
    if (!result.ok) return res.status(result.unsupported ? 501 : 502).json({ success: false, error: result.error });
    res.json({ success: true, session: result.session || null });
  });

  app.post("/api/media/control", requireAuth, async (req, res) => {
    const { action, value } = req.body || {};
    const commands = { toggle: "toggle", play: "play", pause: "pause", next: "next", previous: "prev" };
    let command = commands[action];
    if (action === "seek" && Number.isFinite(Number(value))) command = `seek ${Math.max(0, Math.round(Number(value)))}`;
    if (!command) return res.status(400).json({ success: false, error: "Unknown action." });
    const result = await send((req.body?.any ? "any:" : "") + command);
    if (!result.ok) return res.status(502).json({ success: false, error: result.error || "The player did not accept the command." });
    res.json({ success: true });
  });
}

process.on("exit", stopHelper);

module.exports = { registerMediaSessionRoutes };
