const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  window.loadURL(process.env.WORKBENCH_STRESS_URL)
})
