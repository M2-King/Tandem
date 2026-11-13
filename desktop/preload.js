// The only bridge between the Tandem page and the desktop app: a few window
// actions and the update state. No file system, process or network access is
// exposed here; updates take no arguments, so the page can't choose what to
// download or from where.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('tandemDesktop', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('desktop:info'),
  setMaterial: (material) => ipcRenderer.invoke('desktop:set-material', material),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  openFolder: () => ipcRenderer.invoke('desktop:open-folder'),
  restartRuntime: () => ipcRenderer.invoke('desktop:restart-runtime'),
  windowAction: (action) => ipcRenderer.invoke('desktop:window', action),
  onMaximized: listen('desktop:maximized'),
  onWallpaper: listen('desktop:wallpaper'),
  onRuntimeExit: listen('desktop:runtime-exit'),
  // The Cowork sign-in ("Keep me signed in"), encrypted by the operating system.
  secure: Object.freeze({
    get: (name) => ipcRenderer.invoke('desktop:secure-get', name),
    set: (name, value) => ipcRenderer.invoke('desktop:secure-set', name, value),
  }),
  updates: Object.freeze({
    state: () => ipcRenderer.invoke('desktop:updates-state'),
    check: () => ipcRenderer.invoke('desktop:updates-check'),
    install: () => ipcRenderer.invoke('desktop:updates-install'),
    // The "Updating Tandem" window with a made-up update, to see that it shows.
    preview: () => ipcRenderer.invoke('desktop:updates-preview'),
    onState: listen('desktop:updates'),
  }),
  onOpenFile: listen('desktop:open-file'),
});
