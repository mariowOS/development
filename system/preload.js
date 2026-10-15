const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mariowOSElectron', Object.freeze({
    shutdown: () => ipcRenderer.invoke('mariowos:shutdown'),
    reboot: () => ipcRenderer.invoke('mariowos:reboot'),
    clearBrowserData: () => ipcRenderer.invoke('mariowos:clear-browser-data'),
    onBrowserOpenTab: callback => ipcRenderer.on('browser:open-tab', (_event, url) => callback(String(url))),
    onBrowserShortcut: callback => ipcRenderer.on('browser:shortcut', (_event, name) => callback(String(name)))
}));
