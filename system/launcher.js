// mariowOS Electron entry point. The backend owns the web shell; Electron owns
// the fullscreen window and supervises the backend's explicit lifecycle codes.
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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

function startBackend() {
    if (backendProcess || shuttingDown) return;
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
    child.stderr.on('data', data => console.error(`[kernel]: ${data.toString().trim()}`));
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
        showBootScreen();
        scheduleBackendRestart();
    });

    void waitForBackendHealth(child, instanceId).then(() => {
        if (!isLiveChild(child) || shuttingDown) return;
        backendReady = true;
        backendRestartAttempt = 0;
        console.log('[sniffer]: kernel loaded; booting GUI.');
        const bootUrl = new URL('boot', SHELL_URL);
        if (isVerboseBootEnabled()) bootUrl.searchParams.set('verbose', '1');
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
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.loadFile(bootPage, { query: getBootQuery() }).then(() => {
        startBackend();
    }).catch(error => {
        console.error('[sniffer]: could not load boot animation:', error);
    });
}

app.whenReady().then(() => {
    console.log('[sniffer]: booting...');
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
