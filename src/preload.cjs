const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  call: (action, data) => ipcRenderer.invoke('orbit', action, data),
  onActivity: callback => { const listener=(_,entry)=>callback(entry); ipcRenderer.on('activity',listener); return ()=>ipcRenderer.removeListener('activity',listener); },
  subscribe: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
});
