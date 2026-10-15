// mariowOS - server side of the Music app's "Online services" (Last.fm).
// (C) 2026 mariowstech and the mariowOS team - Licensed under the Apache License, Version 2.0
//
// Last.fm shows what the user is listening to on ANY device or app that scrobbles to it,
// including Spotify Free on a phone. It is read-only and needs only a username and a free
// API key; the key stays on the server and is stripped from /get-settings.

const API = "https://ws.audioscrobbler.com/2.0/";

function registerOnlineServiceRoutes(app, { getConfig, saveConfig, requireAuth }) {
  async function lastfm(method, params, apiKey) {
    const query = new URLSearchParams({ method, api_key: apiKey, format: "json", ...params });
    const response = await fetch(`${API}?${query}`, { headers: { "User-Agent": "mariowOS/1.0" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const error = new Error(data.message || "Last.fm request failed.");
      error.code = data.error;
      throw error;
    }
    return data;
  }

  app.get("/api/lastfm/status", requireAuth, (req, res) => {
    const settings = getConfig().lastfm;
    res.json({ success: true, configured: Boolean(settings?.username && settings?.apiKey), username: settings?.username || null });
  });

  app.post("/api/lastfm/config", requireAuth, async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const apiKey = String(req.body?.apiKey || "").trim().toLowerCase();
    const config = getConfig();
    if (!username && !apiKey) {
      delete config.lastfm;
      saveConfig();
      return res.json({ success: true });
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,14}$/.test(username)) {
      return res.status(400).json({ success: false, error: "That does not look like a Last.fm username." });
    }
    if (!/^[0-9a-f]{32}$/.test(apiKey)) {
      return res.status(400).json({ success: false, error: "The API key is the 32-character code from last.fm/api/account/create." });
    }
    try {
      await lastfm("user.getinfo", { user: username }, apiKey);
    } catch (error) {
      const message = error.code === 10 ? "Last.fm rejected the API key." : error.code === 6 ? "Last.fm user not found." : error.message;
      return res.status(400).json({ success: false, error: message });
    }
    config.lastfm = { username, apiKey };
    saveConfig();
    res.json({ success: true });
  });

  app.get("/api/lastfm/recent", requireAuth, async (req, res) => {
    const settings = getConfig().lastfm;
    if (!settings?.username || !settings?.apiKey) return res.status(400).json({ success: false, error: "Last.fm is not set up." });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    try {
      const data = await lastfm("user.getrecenttracks", { user: settings.username, limit: String(limit) }, settings.apiKey);
      const list = data.recenttracks?.track;
      const tracks = (Array.isArray(list) ? list : list ? [list] : []).map(t => ({
        title: t.name || "",
        artist: t.artist?.["#text"] || "",
        album: t.album?.["#text"] || "",
        image: (t.image || []).reverse().map(i => i["#text"]).find(Boolean) || null,
        nowPlaying: t["@attr"]?.nowplaying === "true",
        playedAt: t.date?.uts ? Number(t.date.uts) * 1000 : null,
        url: /^https:\/\/www\.last\.fm\//.test(t.url || "") ? t.url : null
      }));
      res.json({ success: true, tracks });
    } catch (error) {
      res.status(502).json({ success: false, error: error.message });
    }
  });
}

module.exports = { registerOnlineServiceRoutes };
