const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('stippleCamera', {
  status: () => ipcRenderer.invoke('camera:status'),
  activate: () => ipcRenderer.invoke('camera:activate'),
  sendFrame: pixels => ipcRenderer.invoke('camera:frame', pixels),
  stop: () => ipcRenderer.invoke('camera:stop'),
  openSettings: () => ipcRenderer.invoke('camera:settings'),
})
