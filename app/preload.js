const { contextBridge, ipcRenderer } = require('electron');

// Expose hotspot controls to the frontend safely
contextBridge.exposeInMainWorld('swyftApp', {
  startHotspot: () => ipcRenderer.invoke('hotspot-start'),
  stopHotspot:  () => ipcRenderer.invoke('hotspot-stop'),
  isElectron: true
});