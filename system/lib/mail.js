// mariowOS builder note: client for the mariowOS mail relay (mail-relay/worker.js, a
// Cloudflare Worker). Emails (verification codes, password reset, daily report) are
// sent by the relay, which holds the mail provider's key and generates/checks the codes,
// so no install ever ships a mail password and editing a local install cannot bypass
// email verification. The relay also enforces the cooldowns and anti-mass-mail budget (D-06).

const fs = require("fs");
const http = require("http");
const https = require("https");
const tls = require("tls");

const UNREACHABLE = "Could not reach the mariowOS mail service. Check your connection.";
const NOT_CONFIGURED = "Email service not configured on this system.";

// Trust the OS certificate store too, so antivirus/proxy HTTPS inspection (which
// re-signs TLS with a locally trusted root) doesn't break mail.
function getTrustedCAs() {
  if (typeof tls.getCACertificates !== "function") return undefined;
  try {
    return [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];
  } catch (e) {
    return undefined;
  }
}

function createMailClient({ relayUrl, errorLogFile }) {
  const baseUrl = String(relayUrl || "").replace(/\/+$/, "");
  // Plain http is only allowed for a relay on this machine (`wrangler dev`).
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);
  const configured = (/^https:\/\//.test(baseUrl) || isLocal) && !baseUrl.includes("CHANGE-ME");
  if (!configured) console.warn("[mail] mail relay URL not configured: emails cannot be sent.");

  function post(route, payload) {
    return new Promise(resolve => {
      const body = JSON.stringify(payload);
      const request = (isLocal ? http : https).request(baseUrl + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        ca: getTrustedCAs(),
        timeout: 15000
      }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { if (text.length < 65536) text += chunk; });
        response.on("end", () => {
          let data = {};
          try { data = JSON.parse(text); } catch (e) {}
          resolve({ status: response.statusCode, data });
        });
      });
      request.on("timeout", () => request.destroy(new Error("mail relay timed out")));
      request.on("error", error => {
        console.error("[mail] relay request failed:", error.message);
        if (errorLogFile) {
          try { fs.appendFileSync(errorLogFile, `${new Date().toISOString()} ${route} ${error.message}\n`); } catch (e) {}
        }
        resolve({ status: 0, data: {} });
      });
      request.end(body);
    });
  }

  async function sendCode(purpose, email, username) {
    if (!configured) return { ok: false, status: 503, error: NOT_CONFIGURED };
    const { status, data } = await post("/send-code", { purpose, email, username: username || "" });
    if (status === 200 && data.ok) return { ok: true };
    if (!status) return { ok: false, status: 502, error: UNREACHABLE };
    return { ok: false, status: status >= 400 && status < 600 ? status : 502,
      error: data.error || "Could not send the email.", retryAfter: data.retryAfter };
  }

  // On success for purpose "verify", `token` lets this device request its daily report.
  async function checkCode(purpose, email, code) {
    if (!configured) return { ok: false, error: NOT_CONFIGURED };
    const { status, data } = await post("/verify-code", {
      purpose, email: String(email || "").trim(), code: String(code || "").trim()
    });
    if (status === 200 && data.ok) return { ok: true, token: data.token };
    if (!status) return { ok: false, error: UNREACHABLE };
    return { ok: false, error: data.error || "Could not check the code." };
  }

  async function sendDailyReport({ email, token, username }) {
    if (!configured) return { ok: false, error: NOT_CONFIGURED };
    const { status, data } = await post("/daily-report", { email, token, username: username || "" });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || (status ? `relay status ${status}` : UNREACHABLE) };
  }

  return { configured, relayUrl: baseUrl, sendCode, checkCode, sendDailyReport };
}

module.exports = { createMailClient, getTrustedCAs };
