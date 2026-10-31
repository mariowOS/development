// Shared by every "factory reset" button in Settings.

// The kernel re-checks the account password before wiping anything.
// Resolves to true / false, or null when the kernel is too old to say.
async function factoryResetNeedsPassword() {
  try {
    const res = await fetch('/get-settings', { cache: 'no-store' });
    const data = await res.json();
    return typeof data.hasPassword === 'boolean' ? data.hasPassword : null;
  } catch (e) {
    return null;
  }
}

// Asks for the account password in a dialog. Resolves to the password,
// '' when the account has none, or null when the user cancels.
async function askFactoryResetPassword() {
  const needs = await factoryResetNeedsPassword();
  if (needs === false) return '';
  const password = await mDialog.prompt(
    needs === null
      ? (window.mariowOSI18n ? mariowOSI18n.t('settings.factory-reset.prompt-optional', 'Enter your account password to confirm. Leave it empty if you never set one.') : 'Enter your account password to confirm. Leave it empty if you never set one.')
      : (window.mariowOSI18n ? mariowOSI18n.t('settings.factory-reset.prompt', 'Enter your account password to confirm the factory reset.') : 'Enter your account password to confirm the factory reset.'),
    { type: 'password', title: (window.mariowOSI18n ? mariowOSI18n.t('settings.factory-reset.prompt-title', 'Confirm with password') : 'Confirm with password'), okText: (window.mariowOSI18n ? mariowOSI18n.t('settings.security.erase-everything', 'Erase everything') : 'Erase everything'), danger: true, kind: 'warning' }
  );
  return password === null ? null : password;
}

async function runFactoryReset(password) {
  const res = await fetch('/api/system/factory-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password || '' })
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || !data.success) {
    throw new Error(data ? (data.error || (window.mariowOSI18n ? mariowOSI18n.t('settings.factory-reset.server-error', 'Server error') : 'Server error')) : (window.mariowOSI18n ? mariowOSI18n.t('settings.factory-reset.kernel-outdated', 'The system kernel is outdated: restart mariowOS and try again.') : 'The system kernel is outdated: restart mariowOS and try again.'));
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
