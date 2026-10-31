// mariowOS - tells the desktop when a Bluetooth device connects or disconnects.
// (C) 2026 mariowstech and the mariowOS team - Licensed under the Apache License, Version 2.0
//
// A single helper (tools/bluetooth-watch.ps1) stays running while a desktop is listening, so
// watching costs a few property reads rather than a new PowerShell every few seconds.
// GET /api/system/bt-events is a Server-Sent Events stream of its lines. Windows only.

const path = require("path");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "tools", "bluetooth-watch.ps1");
const RESTART_DELAY_MS = 5000;
const KEEPALIVE_MS = 25000;

const listeners = new Set();
let helper = null;
let restartTimer = null;

function broadcast(line) {
  listeners.forEach(res => res.write(`data: ${line}\n\n`));
}

function startHelper() {
  if (helper || process.platform !== "win32") return;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ParentPid", String(process.pid)], {
    windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
  });
  helper = child;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) broadcast(line);
    }
  });
  child.on("exit", () => {
    if (helper === child) helper = null;
    if (listeners.size) restartTimer = setTimeout(startHelper, RESTART_DELAY_MS);
  });
}

function stopHelper() {
  clearTimeout(restartTimer);
  if (helper) helper.kill();
  helper = null;
}

function registerBluetoothWatchRoutes(app, { requireAuth }) {
  app.get("/api/system/bt-events", requireAuth, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.add(res);
    startHelper();
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(keepalive);
      listeners.delete(res);
      if (!listeners.size) stopHelper();
    });
  });
  process.on("exit", stopHelper);
}

module.exports = { registerBluetoothWatchRoutes };
