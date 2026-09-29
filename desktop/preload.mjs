import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('localFiles', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolders: () => ipcRenderer.invoke('folders:choose'),
  saveConfiguration: (configuration) => ipcRenderer.invoke('config:save', configuration),
  saveSharedConfiguration: (configuration) => ipcRenderer.invoke('config:save-shared', configuration),
  saveConnection: (configuration) => ipcRenderer.invoke('connections:save', configuration),
  deleteConnection: (id) => ipcRenderer.invoke('connections:delete', id),
  setConnectionEnabled: (id, enabled) => ipcRenderer.invoke('connections:set-enabled', id, enabled),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  tripSafety: () => ipcRenderer.invoke('safety:trip'),
  resetSafety: () => ipcRenderer.invoke('safety:reset'),
  localControlToken: () => ipcRenderer.invoke('safety:local-control-token'),
  setLocalSecurityMaintenance: (enabled) => ipcRenderer.invoke('security:set-local-maintenance', enabled),
  openDashboard: () => ipcRenderer.invoke('links:dashboard'),
  openExternal: (name) => ipcRenderer.invoke('links:open', name),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:launch-at-login', enabled),
  setAutomationMode: (mode) => ipcRenderer.invoke('app:set-automation-mode', mode),
  setHeadlessBackground: (enabled) => ipcRenderer.invoke('app:set-headless-background', enabled),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
});
