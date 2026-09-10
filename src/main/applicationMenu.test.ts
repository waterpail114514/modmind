import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { name: 'ModMind' }, Menu: {}, shell: { openExternal: vi.fn() } }))
import { applicationMenuTemplate } from './applicationMenu'
import type { MenuItemConstructorOptions } from 'electron'

describe('macOS application menu', () => {
  it('uses native edit/window/quit roles and routes settings once', () => {
    const settings = vi.fn()
    const template = applicationMenuTemplate(settings, false)
    const items = template.flatMap(menu => Array.isArray(menu.submenu) ? menu.submenu as MenuItemConstructorOptions[] : [])
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll', 'close', 'minimize', 'zoom', 'front', 'quit']) expect(items.some(item => item.role === role)).toBe(true)
    expect(items.some(item => item.role === 'reload' || item.role === 'toggleDevTools')).toBe(false)
    const item = items.find(entry => entry.accelerator === 'CommandOrControl+,')!
    ;(item.click as () => void)()
    expect(settings).toHaveBeenCalledTimes(1)
  })
})
