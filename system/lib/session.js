// mariowOS builder note: login sessions and the account-password brute-force guard.
//
// SESSION AUTHENTICATION (A-02): the backend used to trust every caller. On successful
// login it now issues a signed, HttpOnly, SameSite=Strict session cookie, required for
// every state-changing request. SameSite=Strict also means a malicious web page the user
// visits cannot drive these routes through the browser (CSRF, C-05 / M-05).

const fs = require("fs");
const crypto = require("crypto");

const SESSION_COOKIE = "mw_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

// The signing secret is persisted so sessions survive the frequent backend respawns
// (updates, reboots). It lives in its own file, never in config.json (which is sent to
// the frontend), and is gitignored. A key whose hash is in `leakedKeyHashes` was once
// published online, so anyone could sign sessions with it: it is replaced.
function loadSessionSecret(keyFile, leakedKeyHashes = new Set()) {
  try {
    const secret = fs.readFileSync(keyFile, "utf8").trim();
    if (!secret) throw new Error("empty");
    if (leakedKeyHashes.has(sha256(secret))) {
      console.warn("[auth] This session key was published online; generating a new one.");
      throw new Error("leaked");
    }
    return secret;
  } catch (e) {
    const secret = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(keyFile, secret, { mode: 0o600 }); }
    catch (writeErr) { console.warn("[auth] Could not persist session key:", writeErr.message); }
    return secret;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function createSessions({ keyFile, leakedKeyHashes, secureCookie = false }) {
  const secret = loadSessionSecret(keyFile, leakedKeyHashes);
  const hmac = (prefix, payloadB64) => crypto.createHmac("sha256", secret).update(prefix + payloadB64).digest("base64url");
  const signedEquals = (sig, expected) => {
    const a = Buffer.from(sig || "");
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const decode = payloadB64 => JSON.parse(Buffer.from(payloadB64, "base64url").toString());

  function issueSession(res) {
    const payload = { exp: Date.now() + SESSION_TTL_MS, nonce: crypto.randomBytes(8).toString("hex") };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    res.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${payloadB64}.${hmac("", payloadB64)}; HttpOnly; SameSite=Strict; Path=/; ` +
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` + (secureCookie ? "; Secure" : ""));
  }

  function clearSession(res) {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function hasValidSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || token.indexOf(".") < 0) return false;
    const [payloadB64, sig] = token.split(".");
    if (!signedEquals(sig, hmac("", payloadB64))) return false;
    try {
      const payload = decode(payloadB64);
      return typeof payload.exp === "number" && Date.now() < payload.exp;
    } catch (e) { return false; }
  }

  // Per-app tokens for the endpoint permission model (see app-permissions.json).
  function signAppToken(appId) {
    const payloadB64 = Buffer.from(JSON.stringify({ appId, iat: Date.now() })).toString("base64url");
    return `${payloadB64}.${hmac("app:", payloadB64)}`;
  }

  function verifyAppToken(token) {
    if (typeof token !== "string" || token.indexOf(".") < 0) return null;
    const [payloadB64, sig] = token.split(".");
    if (!signedEquals(sig, hmac("app:", payloadB64))) return null;
    try { return decode(payloadB64); } catch (e) { return null; }
  }

  return { issueSession, clearSession, hasValidSession, signAppToken, verifyAppToken };
}

// Brute-force protection for every account-password check: after 5 consecutive
// failures, all checks are refused for 30 s, doubling up to 15 minutes.
function createPasswordGuard(compareHash) {
  const state = { failures: 0, lockedUntil: 0 };
  const lockSeconds = () => Math.max(0, Math.ceil((state.lockedUntil - Date.now()) / 1000));
  async function comparePassword(candidate, hash) {
    if (!hash || lockSeconds() > 0) return false;
    const ok = typeof candidate === "string" && await compareHash(candidate, hash);
    if (ok) state.failures = 0;
    else if (++state.failures >= 5) {
      state.lockedUntil = Date.now() + Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** (state.failures - 5));
    }
    return ok;
  }
  return { comparePassword, lockSeconds };
}

module.exports = { SESSION_COOKIE, parseCookies, createSessions, createPasswordGuard };
