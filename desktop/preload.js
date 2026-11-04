// The only bridge between the Tandem page and the desktop app: a few window
// actions. No file system, process or network access is exposed here.
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
});
