const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('meetingbot', {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('window-control', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('window-control', 'toggle-maximize'),
    close: () => ipcRenderer.send('window-control', 'close'),
  },
  captureWindow: () => ipcRenderer.invoke('capture-window'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  getDisplays: () => ipcRenderer.invoke('displays-list'),
  openCompanion: (displayId = '') => ipcRenderer.invoke('companion-open', displayId),
  closeCompanion: () => ipcRenderer.invoke('companion-close'),
  companionStatus: () => ipcRenderer.invoke('companion-status'),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || '' } catch { return '' }
  },
  openPath: (kind) => ipcRenderer.invoke('open-path', kind),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
})
