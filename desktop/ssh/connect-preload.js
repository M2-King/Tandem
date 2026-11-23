// The connect window's bridge (connect.html). Only this window can use these;
// main checks the sender. Passwords go from here to the app, never to the
// Tandem page.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('tandemSsh', {
  init: () => ipcRenderer.invoke('ssh:init'),
  pickKey: () => ipcRenderer.invoke('ssh:pick-key'),
  forget: (id) => ipcRenderer.invoke('ssh:forget', id),
  connect: (form) => ipcRenderer.invoke('ssh:connect', form),
  answerHostKey: (yes) => ipcRenderer.invoke('ssh:host-key-answer', yes),
  onProgress: listen('ssh:progress'),
  onHostKey: listen('ssh:host-key'),
});
