import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export function applicationMenuTemplate(openSettings: () => void, development: boolean): MenuItemConstructorOptions[] {
  return [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: '设置…', accelerator: 'CommandOrControl+,', click: openSettings },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
      { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }
    ] },
    { label: '显示', submenu: [...(development ? [{ role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[] : []), { role: 'togglefullscreen' }] },
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [
      { label: '文档', click: () => { void shell.openExternal('https://github.com/waterpail114514/modmind#readme') } },
      { label: '问题反馈', click: () => { void shell.openExternal('https://github.com/waterpail114514/modmind/issues') } }
    ] }
  ]
}
export function installApplicationMenu(openSettings: () => void, development: boolean): void {
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(openSettings, development)))
}
