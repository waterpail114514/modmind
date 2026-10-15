import type { BrowserWindowConstructorOptions } from 'electron'

export function platformWindowOptions(platform = process.platform): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'trafficLightPosition' | 'autoHideMenuBar'> {
  return platform === 'darwin'
    ? { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, autoHideMenuBar: false }
    : { frame: false, titleBarStyle: 'hidden', autoHideMenuBar: true }
}
