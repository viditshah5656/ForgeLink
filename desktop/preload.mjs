import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('localFiles', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolders: () => ipcRenderer.invoke('folders:choose'),
  saveConfiguration: (configuration) => ipcRenderer.invoke('config:save', configuration),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  openDashboard: () => ipcRenderer.invoke('links:dashboard'),
  openExternal: (name) => ipcRenderer.invoke('links:open', name),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:launch-at-login', enabled),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
});
