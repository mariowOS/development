// Chrome extensions for the in-OS browser. They load only into the browser's own session
// (BROWSER_PARTITION), never into the shell's, so no extension can reach the desktop or its apps.
// Store installs are kept under userData/browser-extensions/<id>; unpacked ones stay where they are.
const { app, session, dialog, net } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSER_PARTITION = 'persist:mariowos-browser';
const EXTENSION_ID = /^[a-p]{32}$/;

const extensionsDir = () => path.join(app.getPath('userData'), 'browser-extensions');
const stateFile = () => path.join(extensionsDir(), 'extensions.json');
const browserSession = () => session.fromPartition(BROWSER_PARTITION);
// session.extensions arrived in Electron 35; older builds had the same calls on the session.
const extensionApi = () => browserSession().extensions || browserSession();

function readState() {
    try {
        const list = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        return Array.isArray(list) ? list.filter(item => item && typeof item.path === 'string') : [];
    } catch {
        return [];
    }
}

function writeState(list) {
    fs.mkdirSync(extensionsDir(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(list, null, 2));
}

function readManifest(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

// Names like "__MSG_appName__" come from the extension's own _locales folder.
function localized(dir, manifest, value) {
    const match = /^__MSG_(.+)__$/.exec(value || '');
    if (!match) return value || '';
    const key = match[1].toLowerCase();
    const locales = [app.getLocale().replace('-', '_'), app.getLocale().split('-')[0], manifest.default_locale, 'en'].filter(Boolean);
    for (const locale of locales) {
        try {
            const messages = JSON.parse(fs.readFileSync(path.join(dir, '_locales', locale, 'messages.json'), 'utf8'));
            const entry = Object.entries(messages).find(([name]) => name.toLowerCase() === key);
            if (entry) return entry[1].message;
        } catch {}
    }
    return value;
}

function iconDataUrl(dir, manifest) {
    const action = manifest.action || manifest.browser_action || {};
    const sets = [action.default_icon, manifest.icons].filter(Boolean);
    for (const set of sets) {
        const file = typeof set === 'string' ? set : set[Object.keys(set).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0]];
        if (!file) continue;
        const full = path.resolve(dir, file);
        if (!full.startsWith(path.resolve(dir))) continue;
        try {
            const ext = path.extname(full).slice(1).toLowerCase();
            const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
            return `data:${type};base64,${fs.readFileSync(full).toString('base64')}`;
        } catch {}
    }
    return '';
}

function describe(entry, loaded) {
    let manifest = {};
    try { manifest = readManifest(entry.path); } catch {}
    const action = manifest.action || manifest.browser_action || {};
    return {
        id: loaded ? loaded.id : entry.id,
        name: localized(entry.path, manifest, manifest.name) || entry.id,
        description: localized(entry.path, manifest, manifest.description),
        version: manifest.version || '',
        icon: iconDataUrl(entry.path, manifest),
        popup: action.default_popup ? String(action.default_popup).replace(/^\//, '') : '',
        enabled: entry.enabled !== false,
        source: entry.source,
        manifestVersion: manifest.manifest_version || 2
    };
}

async function loadEntry(entry) {
    const loaded = await extensionApi().loadExtension(entry.path, { allowFileAccess: false });
    entry.id = loaded.id;
    return loaded;
}

async function init() {
    const list = readState();
    for (const entry of list.filter(item => item.enabled !== false)) {
        try { await loadEntry(entry); } catch (error) { console.error(`[browser]: extension ${entry.path} did not load:`, error.message); }
    }
    writeState(list);
}

function list() {
    const loaded = new Map(extensionApi().getAllExtensions().map(ext => [path.resolve(ext.path), ext]));
    return readState().map(entry => describe(entry, loaded.get(path.resolve(entry.path))));
}

// Accepts a Chrome Web Store link or a bare extension id.
function extensionIdFrom(input) {
    const text = String(input || '').trim();
    if (EXTENSION_ID.test(text)) return text;
    const match = /(?:^|[/?=])([a-p]{32})(?:[/?#&]|$)/.exec(text);
    return match ? match[1] : null;
}

// A .crx is a small signed header followed by a plain zip.
function zipFromCrx(buffer) {
    if (buffer.toString('ascii', 0, 4) !== 'Cr24') throw new Error('The Web Store did not send an extension package.');
    const version = buffer.readUInt32LE(4);
    if (version === 3) return buffer.subarray(12 + buffer.readUInt32LE(8));
    if (version === 2) return buffer.subarray(16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12));
    throw new Error(`Unsupported package version ${version}.`);
}

// Windows 10+ ships bsdtar, which also reads zip archives.
function unzip(zipFile, target) {
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xf', zipFile, '-C', target], { windowsHide: true, timeout: 60000 }, error => error ? reject(new Error('Could not unpack the extension.')) : resolve());
    });
}

async function installFromStore(input) {
    const id = extensionIdFrom(input);
    if (!id) throw new Error('That is not a Chrome Web Store link or extension id.');
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3' +
        `&prodversion=${encodeURIComponent(process.versions.chrome)}&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`The Web Store answered ${response.status}.`);
    const zip = zipFromCrx(Buffer.from(await response.arrayBuffer()));

    const target = path.join(extensionsDir(), id);
    const temp = path.join(os.tmpdir(), `mariowos-ext-${id}-${Date.now()}.zip`);
    const staging = `${target}.new`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(temp, zip);
    try {
        await unzip(temp, staging);
        readManifest(staging);
    } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
    } finally {
        fs.rmSync(temp, { force: true });
    }

    // Reinstalling replaces the old copy.
    const state = readState();
    const old = state.find(entry => entry.path === target);
    if (old?.id) { try { extensionApi().removeExtension(old.id); } catch {} }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);

    const entry = { path: target, source: 'store', enabled: true, storeId: id };
    const loaded = await loadEntry(entry);
    writeState([...state.filter(item => item.path !== target), entry]);
    return describe(entry, loaded);
}

async function loadUnpacked(window) {
    const picked = await dialog.showOpenDialog(window, { title: 'Load unpacked extension', properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const dir = picked.filePaths[0];
    try { readManifest(dir); } catch { throw new Error('That folder has no manifest.json.'); }
    const state = readState().filter(item => path.resolve(item.path) !== path.resolve(dir));
    const entry = { path: dir, source: 'unpacked', enabled: true };
    const loaded = await loadEntry(entry);
    writeState([...state, entry]);
    return describe(entry, loaded);
}

function findEntry(state, id) {
    const entry = state.find(item => item.id === id);
    if (!entry) throw new Error('Unknown extension.');
    return entry;
}

async function setEnabled(id, enabled) {
    const state = readState();
    const entry = findEntry(state, id);
    if (enabled && entry.enabled === false) await loadEntry(entry);
    if (!enabled && entry.enabled !== false) { try { extensionApi().removeExtension(id); } catch {} }
    entry.enabled = !!enabled;
    writeState(state);
    return list();
}

function remove(id) {
    const state = readState();
    const entry = findEntry(state, id);
    try { extensionApi().removeExtension(id); } catch {}
    // Only copies we made are deleted; an unpacked folder belongs to the user.
    if (entry.source === 'store' && path.resolve(entry.path).startsWith(path.resolve(extensionsDir()))) {
        fs.rmSync(entry.path, { recursive: true, force: true });
    }
    writeState(state.filter(item => item !== entry));
    return list();
}

module.exports = { BROWSER_PARTITION, browserSession, init, list, installFromStore, loadUnpacked, setEnabled, remove };
