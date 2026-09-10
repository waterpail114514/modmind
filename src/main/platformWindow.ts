import type { BrowserWindowConstructorOptions } from 'electron'

export function platformWindowOptions(platform = process.platform): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'trafficLightPosition'> {
  return platform === 'darwin'
    ? { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
    : { frame: false, titleBarStyle: 'hidden' }
}
