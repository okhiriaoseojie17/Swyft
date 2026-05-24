const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swyftApp', {
  startHotspot:        () => ipcRenderer.invoke('hotspot-start'),
  stopHotspot:         () => ipcRenderer.invoke('hotspot-stop'),
  getLocalIP:          () => ipcRenderer.invoke('get-local-ip'),
  getHotspotInfo:      () => ipcRenderer.invoke('get-hotspot-info'),
  openNetworkSettings: () => ipcRenderer.invoke('open-network-settings'),
  isElectron: true,
});