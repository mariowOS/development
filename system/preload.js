const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mariowOSElectron', Object.freeze({
    shutdown: () => ipcRenderer.invoke('mariowos:shutdown'),
    reboot: () => ipcRenderer.invoke('mariowos:reboot'),
    clearBrowserData: () => ipcRenderer.invoke('mariowos:clear-browser-data')
}));
