// Shared by every "factory reset" button in Settings.
async function runFactoryReset() {
  const res = await fetch('/api/system/factory-reset', { method: 'POST' });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || !data.success) {
    throw new Error(data ? (data.error || 'Server error') : 'The system kernel is outdated: restart mariowOS and try again.');
  }

  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  try {
    if (window.indexedDB && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      dbs.forEach(db => db.name && indexedDB.deleteDatabase(db.name));
    }
  } catch (e) {}
  document.cookie.split(';').forEach(c => {
    document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date(0).toUTCString() + ';path=/');
  });

  // Inside the Electron shell also wipe cookies, cache and storage of the built-in browser.
  try {
    const bridge = window.top.mariowOSElectron;
    if (bridge && bridge.clearBrowserData) await bridge.clearBrowserData();
  } catch (e) { console.warn('Could not clear browser data:', e); }

  // Restart the whole shell (not just the Settings window) from the welcome screen.
  window.top.location.replace('/');
}
