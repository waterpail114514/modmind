import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export function installEditContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    if (!params.isEditable && !params.selectionText) return

    const flags = params.editFlags
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { label: '撤销', role: 'undo', enabled: flags.canUndo },
        { label: '重做', role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: flags.canCut }
      )
    }
    items.push({ label: '复制', role: 'copy', enabled: flags.canCopy })
    if (params.isEditable) items.push({ label: '粘贴', role: 'paste', enabled: flags.canPaste })
    items.push(
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: flags.canSelectAll }
    )
    Menu.buildFromTemplate(items).popup({
      window,
      frame: params.frame ?? undefined,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType
    })
  })
}
