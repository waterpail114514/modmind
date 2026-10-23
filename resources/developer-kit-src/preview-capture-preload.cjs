const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('__devCapture', {
  invoke: (channel, args) => ipcRenderer.invoke('developer:captureInvoke', channel, args),
  onEvent: callback => { ipcRenderer.on('developer:captureEvent', (_event, channel, args) => callback(channel, args)) }
})
