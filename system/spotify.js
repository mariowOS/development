// mariowOS - Spotify Connect remote for the Music app.
// (C) 2026 mariowstech and the mariowOS team - Licensed under the Apache License, Version 2.0
//
// Uses the Authorization Code flow with PKCE, so no client secret is shipped.
// Tokens live only in system/spotify-token.json (mode 0600): they are never sent to
// the browser, never included in /get-settings or backups, and are deleted on logout.
// Audio is played by the user's own Spotify app/device; mariowOS only shows and controls it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKEN_FILE = path.join(__dirname, "spotify-token.json");
const SCOPES = [
  "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
  "playlist-read-private", "playlist-read-collaborative"
].join(" ");
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingLogins = new Map(); // state -> { verifier, createdAt }

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch (e) { return null; }
}
function writeToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}
function deleteToken() {
  fs.rmSync(TOKEN_FILE, { force: true });
}

function registerSpotifyRoutes(app, { getConfig, saveConfig, hasValidSession, port }) {
  const redirectUri = `http://127.0.0.1:${port}/api/spotify/callback`;
  const clientId = () => getConfig().spotifyClientId || process.env.MARIOWOS_SPOTIFY_CLIENT_ID || "";

  const requireAuth = (req, res, next) => {
    if (!getConfig().passwordHash || hasValidSession(req)) return next();
    res.status(401).json({ success: false, error: "Authentication required. Please log in again." });
  };

  async function accessToken() {
    const token = readToken();
    if (!token) return null;
    if (token.expiresAt - 60 * 1000 > Date.now()) return token.accessToken;
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: clientId() })
    });
    if (!response.ok) {
      // Revoked or expired refresh token: forget it so the UI asks to reconnect.
      if (response.status === 400 || response.status === 401) deleteToken();
      return null;
    }
    const data = await response.json();
    writeToken({
      ...token,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || token.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000
    });
    return data.access_token;
  }

  // Calls the Spotify Web API and turns its errors into messages the UI can show.
  async function spotifyApi(method, endpoint, body) {
    const tokenValue = await accessToken();
    if (!tokenValue) return { status: 401, data: { error: "not-connected" } };
    const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${tokenValue}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 204) return { status: 204, data: null };
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { status: response.status, data };
  }

  function sendApiError(res, result) {
    const reason = result.data?.error?.reason;
    const messages = {
      NO_ACTIVE_DEVICE: "Open Spotify on a device (PC, phone or speaker) and start playing something first.",
      PREMIUM_REQUIRED: "Controlling playback requires Spotify Premium."
    };
    // Some errors (e.g. the app owner's Premium requirement) come back as plain text.
    const raw = typeof result.data?.raw === "string" ? result.data.raw.trim().slice(0, 300) : "";
    const message = messages[reason] || result.data?.error?.message || raw ||
      (result.status === 401 ? "Spotify is not connected." : result.status === 429 ? "Too many requests, try again in a moment." : "Spotify request failed.");
    res.status(result.status >= 400 ? result.status : 502).json({ success: false, error: message, reason: reason || null });
  }

  app.get("/api/spotify/status", requireAuth, (req, res) => {
    const token = readToken();
    res.json({
      success: true,
      configured: Boolean(clientId()),
      connected: Boolean(token),
      user: token?.user || null,
      redirectUri
    });
  });

  app.post("/api/spotify/client-id", requireAuth, (req, res) => {
    const id = String(req.body?.clientId || "").trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      return res.status(400).json({ success: false, error: "The Client ID is the 32-character code shown in your Spotify app's settings." });
    }
    const config = getConfig();
    if (config.spotifyClientId !== id) deleteToken(); // tokens belong to the old app
    config.spotifyClientId = id;
    saveConfig();
    res.json({ success: true });
  });

  // No session check here: this only redirects to Spotify, and tokens are stored only
  // for a callback whose one-time `state` was issued by this route.
  app.get("/api/spotify/login", (req, res) => {
    if (!clientId()) return res.status(400).send("Spotify is not configured yet: add your Client ID in the Music app.");
    for (const [state, entry] of pendingLogins) {
      if (Date.now() - entry.createdAt > PENDING_TTL_MS) pendingLogins.delete(state);
    }
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");
    pendingLogins.set(state, { verifier, createdAt: Date.now() });
    const params = new URLSearchParams({
      response_type: "code", client_id: clientId(), scope: SCOPES, redirect_uri: redirectUri,
      state, code_challenge_method: "S256", code_challenge: challenge
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });

  app.get("/api/spotify/callback", async (req, res) => {
    const page = (title, message, ok) => res.status(ok ? 200 : 400).send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <link href="/desktop/assets/fonts/fonts.css" rel="stylesheet"><title>${title}</title>
      <style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
      font-family:Poppins,sans-serif;background:#121212;color:#fff;text-align:center;padding:16px}
      .i{font-family:'Material Symbols Outlined';font-size:56px;color:${ok ? "#1ed760" : "#ff453a"}}p{color:#b3b3b3;max-width:420px}</style></head>
      <body><div class="i">${ok ? "check_circle" : "error"}</div><h2>${title}</h2><p>${message}</p></body></html>`);

    const { code, state, error } = req.query;
    const pending = typeof state === "string" ? pendingLogins.get(state) : null;
    if (pending) pendingLogins.delete(state);
    if (error) return page("Connection cancelled", "Spotify was not connected. You can close this tab.", false);
    if (!pending || typeof code !== "string" || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      return page("Link expired", "Start the connection again from the Music app.", false);
    }
    try {
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code, redirect_uri: redirectUri,
          client_id: clientId(), code_verifier: pending.verifier
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error_description || data.error || "Token exchange failed");
      writeToken({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 });
      const me = await spotifyApi("GET", "/me");
      if (me.status === 200) {
        writeToken({ ...readToken(), user: { name: me.data.display_name || me.data.id, product: me.data.product || null } });
      }
      page("Spotify connected", "You can close this tab and go back to Music.", true);
    } catch (err) {
      console.error("Spotify login failed:", err);
      page("Connection failed", "Check that the Redirect URI in your Spotify app is exactly " + redirectUri, false);
    }
  });

  app.post("/api/spotify/logout", requireAuth, (req, res) => {
    deleteToken();
    res.json({ success: true });
  });

  app.get("/api/spotify/player", requireAuth, async (req, res) => {
    try {
      const result = await spotifyApi("GET", "/me/player?additional_types=episode");
      if (result.status === 204) return res.json({ success: true, player: null });
      if (result.status !== 200) return sendApiError(res, result);
      const p = result.data;
      const item = p.item || {};
      res.json({
        success: true,
        player: {
          isPlaying: Boolean(p.is_playing),
          progressMs: p.progress_ms || 0,
          durationMs: item.duration_ms || 0,
          shuffle: Boolean(p.shuffle_state),
          repeat: p.repeat_state || "off",
          device: p.device ? { name: p.device.name, type: p.device.type, volume: p.device.volume_percent } : null,
          track: item.name ? {
            title: item.name,
            artist: (item.artists || []).map(a => a.name).join(", ") || item.show?.name || "",
            album: item.album?.name || "",
            image: (item.album?.images || item.images || [])[0]?.url || null
          } : null
        }
      });
    } catch (err) { res.status(502).json({ success: false, error: "Could not reach Spotify." }); }
  });

  app.get("/api/spotify/playlists", requireAuth, async (req, res) => {
    try {
      const result = await spotifyApi("GET", "/me/playlists?limit=50");
      if (result.status !== 200) return sendApiError(res, result);
      res.json({
        success: true,
        playlists: (result.data.items || []).filter(Boolean).map(pl => ({
          uri: pl.uri, name: pl.name, owner: pl.owner?.display_name || "",
          tracks: pl.tracks?.total ?? pl.items?.total ?? null, image: (pl.images || [])[0]?.url || null
        }))
      });
    } catch (err) { res.status(502).json({ success: false, error: "Could not reach Spotify." }); }
  });

  app.post("/api/spotify/control", requireAuth, async (req, res) => {
    const { action, value, uri } = req.body || {};
    const calls = {
      play: () => spotifyApi("PUT", "/me/player/play"),
      pause: () => spotifyApi("PUT", "/me/player/pause"),
      next: () => spotifyApi("POST", "/me/player/next"),
      previous: () => spotifyApi("POST", "/me/player/previous"),
      volume: () => spotifyApi("PUT", `/me/player/volume?volume_percent=${Math.round(Math.min(100, Math.max(0, Number(value) || 0)))}`),
      seek: () => spotifyApi("PUT", `/me/player/seek?position_ms=${Math.max(0, Math.round(Number(value) || 0))}`),
      shuffle: () => spotifyApi("PUT", `/me/player/shuffle?state=${value ? "true" : "false"}`),
      repeat: () => spotifyApi("PUT", `/me/player/repeat?state=${["off", "context", "track"].includes(value) ? value : "off"}`),
      "play-context": () => /^spotify:(playlist|album|artist):[A-Za-z0-9]+$/.test(String(uri))
        ? spotifyApi("PUT", "/me/player/play", { context_uri: uri })
        : Promise.resolve({ status: 400, data: { error: { message: "Invalid playlist." } } })
    };
    if (!calls[action]) return res.status(400).json({ success: false, error: "Unknown action." });
    try {
      const result = await calls[action]();
      if (result.status >= 400) return sendApiError(res, result);
      res.json({ success: true });
    } catch (err) { res.status(502).json({ success: false, error: "Could not reach Spotify." }); }
  });
}

module.exports = { registerSpotifyRoutes };
