// mariowOS Electron entry point. The backend owns the web shell; Electron owns
// the fullscreen window and supervises the backend's explicit lifecycle codes.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-features', 'CSSBackdropFilter');

const PORT = Number(process.env.MARIOWOS_PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('invalid port. it must be a valid TCP port');
}
const HEALTH_PATH = '/api/system/health';
const SHELL_URL = `http://127.0.0.1:${PORT}/`;
const EXIT_CODES = Object.freeze({ SHUTDOWN: 20, UPDATE_RESTART: 21, KERNEL_REBOOT: 22 });
const bootPage = path.join(__dirname, 'boot.html');
const kernelRecoveryPage = path.join(__dirname, 'kernel-recovery.html');
const rollback = require('./lib/rollback');
const browserExtensions = require('./lib/browser-extensions');
// Consecutive kernel failures before undoing the last update / showing the recovery screen.
const ROLLBACK_AFTER_FAILURES = 3;
const RECOVERY_AFTER_FAILURES = 5;
const KERNEL_ERROR_LINES = 80;
let kernelErrorLines = [];
let inKernelRecovery = false;
const bootModeFile = path.join(__dirname, 'boot-mode.json');
const shutdownToken = crypto.randomBytes(32).toString('hex');

let backendProcess = null;
let backendRestartTimer = null;
let backendRestartAttempt = 0;
let backendReady = false;
let shuttingDown = false;
let mainWindow = null;

function isVerboseBootEnabled() {
    if (!fs.existsSync(bootModeFile)) return false;
    try {
        const setting = JSON.parse(fs.readFileSync(bootModeFile, 'utf8'));
        if (typeof setting.verbose !== 'boolean') throw new Error('the verbose boot flag must be a boolean');
        return setting.verbose;
    } catch (error) {
        console.error('[sniffer]: could not read boot mode:', error.message);
        return true;
    }
}

function getBootQuery() {
    return isVerboseBootEnabled() ? { verbose: '1' } : {};
}

function requestJson(pathname, { method = 'GET', headers = {}, timeoutMs = 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port: PORT,
            path: pathname,
            method,
            headers,
            timeout: timeoutMs
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`Backend returned HTTP ${response.statusCode || 'unknown'}`));
                    return;
                }
                try {
                    resolve(body ? JSON.parse(body) : {});
                } catch (error) {
                    reject(new Error(`kernel returned invalid JSON: ${error.message}`));
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('kernel request timed out')));
        request.on('error', reject);
        request.end();
    });
}

function isLiveChild(child) {
    return backendProcess === child && child.exitCode === null && child.signalCode === null;
}

async function waitForBackendHealth(child, instanceId, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = new Error('Backend health endpoint is not ready');

    while (!shuttingDown && isLiveChild(child) && Date.now() < deadline) {
        try {
            const health = await requestJson(HEALTH_PATH, { timeoutMs: 1000 });
            if (health.status === 'ok' && health.instanceId === instanceId) return;
            lastError = new Error('health endpoint belongs to a different kernel adress');
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`kernel did not start: ${lastError.message}`);
}

function isTrustedRendererEvent(event) {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    if (event.senderFrame !== event.sender.mainFrame) return false;

    try {
        const senderUrl = new URL(event.senderFrame.url);
        return senderUrl.protocol === 'http:' &&
            senderUrl.hostname === '127.0.0.1' &&
            senderUrl.port === String(PORT);
    } catch {
        return false;
    }
}

ipcMain.handle('mariowos:shutdown', async (event) => {
    if (!isTrustedRendererEvent(event)) throw new Error('shutdown request rejected for an untrusted renderer');
    if (!backendProcess || !backendReady) throw new Error('kernel is not ready to shut down: BUSY');

    await requestJson('/api/system/shutdown', {
        method: 'POST',
        headers: { Authorization: `Bearer ${shutdownToken}` },
        timeoutMs: 3000
    });
    return { accepted: true };
});

ipcMain.handle('mariowos:clear-browser-data', async (event) => {
    if (!isTrustedRendererEvent(event)) throw new Error('clear request rejected for an untrusted renderer');
    // Browser tabs live in their own session; extensions keep their own storage.
    const browser = browserExtensions.browserSession();
    await browser.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'shadercache', 'serviceworkers', 'filesystem'] });
    await browser.clearCache();
    return { cleared: true };
});

// Browser extensions: only the desktop shell may manage them (see lib/browser-extensions.js).
const extensionHandler = (name, run) => ipcMain.handle('mariowos:extensions-' + name, async (event, ...args) => {
    if (!isTrustedRendererEvent(event)) throw new Error('extension request rejected for an untrusted renderer');
    return run(...args);
});
extensionHandler('list', () => browserExtensions.list());
extensionHandler('install', input => browserExtensions.installFromStore(input));
extensionHandler('load-unpacked', () => browserExtensions.loadUnpacked(mainWindow));
extensionHandler('set-enabled', (id, enabled) => browserExtensions.setEnabled(String(id), !!enabled));
extensionHandler('remove', id => browserExtensions.remove(String(id)));

ipcMain.handle('mariowos:reboot', async (event) => {
    if (!isTrustedRendererEvent(event)) throw new Error('reboot request rejected for an untrusted renderer');
    if (!backendProcess || !backendReady) throw new Error('kernel is not ready to reboot: BUSY');

    await requestJson('/api/system/reboot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${shutdownToken}` },
        timeoutMs: 3000
    });
    return { accepted: true };
});

function rememberKernelError(text) {
    kernelErrorLines.push(...text.split(/\r?\n/));
    if (kernelErrorLines.length > KERNEL_ERROR_LINES) kernelErrorLines = kernelErrorLines.slice(-KERNEL_ERROR_LINES);
}

// --- KERNEL RECOVERY ---
// Shown (from a local file, no kernel needed) after the kernel failed to start several
// times in a row. Automatic restarts stop; the user picks what to do next.
function showKernelRecovery() {
    inKernelRecovery = true;
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
    console.error('[sniffer]: kernel keeps failing; showing the recovery screen.');
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Same language as the system apps (Settings › General › Language), English by default.
    let lang = 'en';
    try { lang = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).language || 'en'; } catch {}
    mainWindow.loadFile(kernelRecoveryPage, { query: { lang } }).catch(error => {
        console.error('[sniffer]: could not show the recovery screen:', error);
    });
}

function isTrustedRecoveryEvent(event) {
    if (!inKernelRecovery || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    if (event.senderFrame !== event.sender.mainFrame) return false;
    return event.senderFrame.url.split('?')[0] === pathToFileURL(kernelRecoveryPage).href;
}

function restartFromRecovery() {
    inKernelRecovery = false;
    backendRestartAttempt = 0;
    kernelErrorLines = [];
    showBootScreen();
    if (!backendProcess) startBackend();
}

ipcMain.handle('mariowos:recovery-state', (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    const point = rollback.readRollbackPoint(__dirname);
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch {}
    return {
        version,
        errors: kernelErrorLines.join('\n'),
        rollback: point && !point.rolledBack ? { fromVersion: point.fromVersion, toVersion: point.toVersion } : null
    };
});

ipcMain.handle('mariowos:recovery-retry', (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    restartFromRecovery();
    return { ok: true };
});

ipcMain.handle('mariowos:recovery-rollback', (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    const restored = rollback.restoreRollbackPoint(__dirname);
    console.warn(`[sniffer]: user restored ${restored.fromVersion || 'the previous version'} from recovery.`);
    restartFromRecovery();
    return { ok: true };
});

ipcMain.handle('mariowos:recovery-repair', async (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    const ok = await installKernelDependencies();
    if (ok) restartFromRecovery();
    return { ok };
});

ipcMain.handle('mariowos:recovery-open-folder', (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    const logFile = path.join(__dirname, 'mariowos.log');
    if (fs.existsSync(logFile)) shell.showItemInFolder(logFile);
    else shell.openPath(__dirname);
    return { ok: true };
});

// Sent only when the user presses "Send report" on the recovery screen. Personal details
// (home folder, user name, email addresses) are removed before anything leaves the device.
const CRASH_REPORT_URL = `${(process.env.MARIOWOS_MAIL_RELAY_URL || 'https://mariowos-mail.mariowos.workers.dev').replace(/\/+$/, '')}/crash-report`;
function scrubReport(text) {
    let clean = String(text || '');
    const home = os.homedir();
    const user = os.userInfo().username;
    for (const variant of new Set([home, home.replace(/\\/g, '\\\\'), home.replace(/\\/g, '/')])) {
        clean = clean.split(variant).join('~');
    }
    if (user && user.length > 2) clean = clean.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
    return clean.replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[a-z]{2,}/gi, '<email>').slice(-6000);
}

ipcMain.handle('mariowos:recovery-send-report', async (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch {}
    const { net } = require('electron');
    const response = await net.fetch(CRASH_REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'kernel-crash', version, platform: `${process.platform} ${os.release()}`, errors: scrubReport(kernelErrorLines.join('\n')) })
    });
    return { ok: response.ok };
});

ipcMain.handle('mariowos:recovery-quit', (event) => {
    if (!isTrustedRecoveryEvent(event)) throw new Error('recovery request rejected');
    shuttingDown = true;
    app.quit();
    return { ok: true };
});

function showBootScreen() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadFile(bootPage, { query: getBootQuery() }).catch(error => {
        console.error('[sniffer]: could not show boot screen:', error);
    });
}

function scheduleBackendRestart() {
    if (shuttingDown || backendRestartTimer) return;
    const delayMs = Math.min(500 * (2 ** backendRestartAttempt), 8000);
    backendRestartAttempt += 1;
    console.warn(`[sniffer]: restarting kernel in ${delayMs} ms`);
    backendRestartTimer = setTimeout(() => {
        backendRestartTimer = null;
        if (!shuttingDown && !backendProcess) startBackend();
    }, delayMs);
}

async function waitForUpdateReplacement(markerPath) {
    const deadline = Date.now() + 70000;
    while (!shuttingDown && Date.now() < deadline) {
        try {
            const result = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
            fs.rmSync(markerPath, { force: true });
            if (!result.success) {
                console.error('[sniffer]: kernel update failed:', result.error || 'unknown update error');
            } else {
                console.log('[sniffer]: Verified kernel update is complete.');
            }
            return;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[sniffer]: could not read update result:', error);
                fs.rmSync(markerPath, { force: true });
                return;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.error('[sniffer]: timed out waiting for the kernel replacement helper.');
    fs.rmSync(markerPath, { force: true });
}

async function restartAfterUpdate(markerPath) {
    await waitForUpdateReplacement(markerPath);
    if (shuttingDown || backendProcess) return;
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!shuttingDown && !backendProcess) startBackend();
}

// A missing package (fresh clone, cleaned node_modules, an update that added a dependency)
// makes the kernel die on its first require and crash-loop forever. Repair it once per
// session with `npm install` before spawning the kernel instead.
let dependencyRepairAttempted = false;
let dependencyRepairRunning = false;

function findMissingKernelDependencies() {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return Object.keys(manifest.dependencies || {})
            .filter(name => !fs.existsSync(path.join(__dirname, 'node_modules', ...name.split('/'), 'package.json')));
    } catch (error) {
        console.error('[sniffer]: could not read kernel dependencies:', error.message);
        return [];
    }
}

function installKernelDependencies() {
    return new Promise(resolve => {
        // Fixed command string: npm is a .cmd shim on Windows, so it needs a shell.
        const child = spawn('npm install --omit=dev --no-audit --no-fund', {
            cwd: __dirname,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        child.stdout.on('data', data => console.log(`[npm]: ${data.toString().trim()}`));
        child.stderr.on('data', data => console.error(`[npm]: ${data.toString().trim()}`));
        child.on('error', error => {
            console.error('[sniffer]: could not run npm:', error.message);
            resolve(false);
        });
        child.on('exit', code => resolve(code === 0));
    });
}

function startBackend() {
    if (backendProcess || shuttingDown || dependencyRepairRunning) return;
    if (!dependencyRepairAttempted) {
        const missing = findMissingKernelDependencies();
        if (missing.length) {
            dependencyRepairAttempted = true;
            dependencyRepairRunning = true;
            console.warn(`[sniffer]: kernel dependencies missing (${missing.join(', ')}); installing...`);
            void installKernelDependencies().then(ok => {
                dependencyRepairRunning = false;
                console.log(ok ? '[sniffer]: kernel dependencies installed.' : '[sniffer]: dependency install failed; booting anyway.');
                startBackend();
            });
            return;
        }
    }
    const instanceId = crypto.randomBytes(16).toString('hex');
    const updateMarker = path.join(os.tmpdir(), `mariowos-update-${process.pid}-${instanceId}.json`);
    const child = spawn(process.env.MARIOWOS_NODE_EXECUTABLE || 'node', ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            MARIOWOS_MANAGED_BACKEND: '1',
            MARIOWOS_BACKEND_INSTANCE_ID: instanceId,
            MARIOWOS_SHUTDOWN_TOKEN: shutdownToken,
            MARIOWOS_UPDATE_MARKER: updateMarker
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    backendProcess = child;
    backendReady = false;
    child.updateMarker = updateMarker;

    child.stdout.on('data', data => console.log(`[kernel]: ${data.toString().trim()}`));
    child.stderr.on('data', data => {
        const text = data.toString().trim();
        console.error(`[kernel]: ${text}`);
        rememberKernelError(text);
    });
    child.on('error', error => console.error('[sniffer]: kernel couldn\'t start', error));
    child.on('exit', (code, signal) => {
        if (backendProcess === child) backendProcess = null;
        backendReady = false;
        if (shuttingDown) {
            fs.rmSync(updateMarker, { force: true });
            return;
        }

        if (code === EXIT_CODES.SHUTDOWN) {
            console.log('[sniffer]: shutdown requested.');
            shuttingDown = true;
            clearTimeout(backendRestartTimer);
            backendRestartTimer = null;
            fs.rmSync(updateMarker, { force: true });
            app.quit();
            return;
        }

        if (code === EXIT_CODES.UPDATE_RESTART) {
            console.log('[sniffer]: kernel update verified; restarting...');
            backendRestartAttempt = 0;
            showBootScreen();
            void restartAfterUpdate(updateMarker).catch(error => {
                console.error('[sniffer]: could not complete kernel restart:', error);
                fs.rmSync(updateMarker, { force: true });
                scheduleBackendRestart();
            });
            return;
        }

        if (code === EXIT_CODES.KERNEL_REBOOT) {
            console.log('[sniffer]: kernel reboot requested; restarting....');
            backendRestartAttempt = 0;
            fs.rmSync(updateMarker, { force: true });
            showBootScreen();
            setTimeout(() => {
                if (!shuttingDown && !backendProcess) startBackend();
            }, 250);
            return;
        }

        fs.rmSync(updateMarker, { force: true });
        console.warn(`[sniffer]: kernel crashed unexpectedly (${signal || code}); recovering.`);
        const failures = backendRestartAttempt + 1;
        // An update that never boots is undone automatically, then retried at once.
        if (failures >= ROLLBACK_AFTER_FAILURES && rollback.canRollback(__dirname) &&
            !rollback.readRollbackPoint(__dirname).verified) {
            try {
                const restored = rollback.restoreRollbackPoint(__dirname);
                console.warn(`[sniffer]: update ${restored.toVersion || ''} did not boot; restored ${restored.fromVersion || 'the previous version'}.`);
                backendRestartAttempt = 0;
                showBootScreen();
                startBackend();
                return;
            } catch (error) {
                console.error('[sniffer]: automatic rollback failed:', error);
            }
        }
        // Retrying forever only shows "Failed to fetch": hand the user a recovery screen.
        if (failures >= RECOVERY_AFTER_FAILURES) {
            showKernelRecovery();
            return;
        }
        showBootScreen();
        scheduleBackendRestart();
    });

    void waitForBackendHealth(child, instanceId).then(() => {
        if (!isLiveChild(child) || shuttingDown) return;
        backendReady = true;
        backendRestartAttempt = 0;
        inKernelRecovery = false;
        try { rollback.markRollbackVerified(__dirname); }
        catch (error) { console.error('[sniffer]: could not confirm the update:', error.message); }
        console.log('[sniffer]: kernel loaded; booting GUI.');
        const bootUrl = new URL('boot', SHELL_URL);
        if (isVerboseBootEnabled()) bootUrl.searchParams.set('verbose', '1');
        // The local boot page already played the intro: the served one continues from it.
        if (mainWindow?.webContents.getURL().startsWith('file:')) bootUrl.searchParams.set('continue', '1');
        mainWindow?.loadURL(bootUrl.href).catch(error => {
            if (error.errno !== -3 && error.code !== 'ERR_ABORTED') {
                console.error('[sniffer]: could not load the boot preloader:', error);
            }
        });
    }).catch(error => {
        if (!isLiveChild(child) || shuttingDown) return;
        console.error('[sniffer]: kernel readiness failed:', error);
        child.kill();
    });
}

// The mouse back/forward buttons would walk the shell's history (desktop -> login -> boot...).
// Swallow them in every frame of the shell; <webview> browser tabs keep their own navigation.
const MOUSE_NAV_BLOCKER = `(() => {
    if (window.__mariowosMouseNavBlocked) return;
    window.__mariowosMouseNavBlocked = true;
    const block = event => {
        if (event.button === 3 || event.button === 4) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
    ['mousedown', 'mouseup', 'auxclick', 'pointerdown', 'pointerup'].forEach(type =>
        window.addEventListener(type, block, true));
})();`;

// Inside a browser tab the mouse back/forward buttons must walk that tab's history,
// not the shell's: block the default and navigate the page itself.
const WEBVIEW_MOUSE_NAV = `(() => {
    if (window.__mariowosMouseNav) return;
    window.__mariowosMouseNav = true;
    const handle = event => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'mouseup') event.button === 3 ? history.back() : history.forward();
    };
    ['mousedown', 'mouseup', 'auxclick', 'pointerdown', 'pointerup'].forEach(type =>
        window.addEventListener(type, handle, true));
})();`;

// No scrollbars anywhere in the shell (content still scrolls). Applied per frame so every
// app and iframe gets it; <webview> browser tabs are separate pages and keep theirs.
const HIDE_SCROLLBARS = `(() => {
    if (window.__mariowosScrollbarsHidden) return;
    window.__mariowosScrollbarsHidden = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { scrollbar-width: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})();`;

// Interface text can't be selected, on the OS's own pages only: chats and third-party apps
// keep their behaviour. It is set on the root so it cascades, and any page can mark text with
// `user-select: text` to keep it selectable, as inputs and editors are here.
const BLOCK_TEXT_SELECTION = `(() => {
    if (window.__mariowosSelectionBlocked || location.origin !== ${JSON.stringify(new URL(SHELL_URL).origin)}) return;
    window.__mariowosSelectionBlocked = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(':root { user-select: none; } input, textarea, [contenteditable]:not([contenteditable="false"]) { user-select: text; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})();`;

function blockMouseHistoryNavigation(win) {
    const inject = frame => {
        if (!frame || frame.isDestroyed?.()) return;
        frame.executeJavaScript(MOUSE_NAV_BLOCKER).catch(() => {});
        frame.executeJavaScript(HIDE_SCROLLBARS).catch(() => {});
        frame.executeJavaScript(BLOCK_TEXT_SELECTION).catch(() => {});
    };
    win.webContents.on('dom-ready', () => inject(win.webContents.mainFrame));
    win.webContents.on('frame-created', (event, { frame }) => {
        if (frame) frame.on('dom-ready', () => inject(frame));
    });
    // Windows also reports these buttons as app commands.
    win.on('app-command', (event, command) => {
        if (command === 'browser-backward' || command === 'browser-forward') event.preventDefault();
    });
}

function bootMariowOS() {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    shuttingDown = false;
    backendReady = false;
    mainWindow = new BrowserWindow({
        fullscreen: true,
        autoHideMenuBar: true,
        frame: false,
        backgroundColor: '#05070b',
        title: 'mariowOS',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            sandbox: true
        }
    });
    mainWindow.webContents.on('context-menu', event => event.preventDefault());
    blockMouseHistoryNavigation(mainWindow);
    // The shell must never navigate "back" (boot -> login -> desktop): Chromium can still
    // route the mouse back button from a browser tab to the shell, so the shell keeps no history.
    mainWindow.webContents.on('did-navigate', () => {
        const history = mainWindow?.webContents?.navigationHistory;
        if (history?.clear) history.clear();
        else mainWindow?.webContents?.clearHistory?.();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.loadFile(bootPage, { query: getBootQuery() }).then(() => {
        startBackend();
    }).catch(error => {
        console.error('[sniffer]: could not load boot animation:', error);
    });
}

// SECURITY (B-01): webviewTag is enabled for the in-OS browser app, so every webview
// and every attempt to open a new window must be constrained. Without this, a page
// loaded in a webview could attach a webview with nodeIntegration on, inject a
// preload, or pop native windows pointing anywhere.
app.on('web-contents-created', (_event, contents) => {
    // Never let a child webview turn Node back on or load a preload of its choosing.
    contents.on('will-attach-webview', (_e, webPreferences, params) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
    });
    // Window.open / target=_blank: from a browser tab (webview) open it as a new in-OS tab;
    // from anything else open http(s) in the user's real browser. Native windows are always denied.
    const isWebview = contents.getType() === 'webview';
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            if (isWebview && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:open-tab', url);
            else shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    // Keyboard focus inside a webview never reaches the desktop page, so browser
    // shortcuts are intercepted here and forwarded to it.
    if (isWebview) {
        contents.on('dom-ready', () => contents.executeJavaScript(WEBVIEW_MOUSE_NAV).catch(() => {}));
        contents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown') return;
            const shortcut = browserShortcutFor(input);
            if (!shortcut || !mainWindow || mainWindow.isDestroyed()) return;
            event.preventDefault();
            mainWindow.webContents.send('browser:shortcut', shortcut);
        });
    }
});

function browserShortcutFor(input) {
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (key === 'f5' || (ctrl && key === 'r')) return 'reload';
    if (input.alt && key === 'arrowleft') return 'back';
    if (input.alt && key === 'arrowright') return 'forward';
    if (!ctrl) return null;
    if (key === 'tab') return input.shift ? 'prev-tab' : 'next-tab';
    return { t: 'new-tab', w: 'close-tab', l: 'focus-url', f: 'find',
        '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset' }[key] || null;
}

app.whenReady().then(async () => {
    console.log('[sniffer]: booting...');
    await browserExtensions.init().catch(error => console.error('[browser]: extensions did not load:', error.message));
    bootMariowOS();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) bootMariowOS();
    });
});

app.on('window-all-closed', () => {
    console.log('[sniffer]: system shutdown initiated...');
    shuttingDown = true;
    backendReady = false;
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
    if (backendProcess) backendProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    shuttingDown = true;
    backendReady = false;
    clearTimeout(backendRestartTimer);
    if (backendProcess) backendProcess.kill();
});
