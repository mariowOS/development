const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mariowOSElectron', Object.freeze({
    shutdown: () => ipcRenderer.invoke('mariowos:shutdown'),
    reboot: () => ipcRenderer.invoke('mariowos:reboot'),
    clearBrowserData: () => ipcRenderer.invoke('mariowos:clear-browser-data'),
    browserExtensions: Object.freeze({
        list: () => ipcRenderer.invoke('mariowos:extensions-list'),
        install: input => ipcRenderer.invoke('mariowos:extensions-install', String(input)),
        loadUnpacked: () => ipcRenderer.invoke('mariowos:extensions-load-unpacked'),
        setEnabled: (id, enabled) => ipcRenderer.invoke('mariowos:extensions-set-enabled', String(id), !!enabled),
        remove: id => ipcRenderer.invoke('mariowos:extensions-remove', String(id))
    }),
    onBrowserOpenTab: callback => ipcRenderer.on('browser:open-tab', (_event, url) => callback(String(url))),
    onBrowserShortcut: callback => ipcRenderer.on('browser:shortcut', (_event, name) => callback(String(name))),
    // Only answered for the local kernel-recovery.html screen (checked in launcher.js).
    kernelRecovery: Object.freeze({
        getState: () => ipcRenderer.invoke('mariowos:recovery-state'),
        retry: () => ipcRenderer.invoke('mariowos:recovery-retry'),
        rollback: () => ipcRenderer.invoke('mariowos:recovery-rollback'),
        repairDependencies: () => ipcRenderer.invoke('mariowos:recovery-repair'),
        openLogFolder: () => ipcRenderer.invoke('mariowos:recovery-open-folder'),
        sendReport: () => ipcRenderer.invoke('mariowos:recovery-send-report'),
        quit: () => ipcRenderer.invoke('mariowos:recovery-quit')
    })
}));
