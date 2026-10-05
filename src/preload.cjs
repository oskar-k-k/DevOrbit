const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  call: (action, data) => ipcRenderer.invoke('orbit', action, data),
  subscribe: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
});
