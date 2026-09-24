import { ipcMain, type WebContents } from 'electron'
import type { PluginImportPreview } from '../shared/plugins'

/** Keep the decision tied to the requesting window; losing that window cancels. */
export function requestPluginImportConfirmation(sender: WebContents, requestId: string, preview: PluginImportPreview): Promise<boolean> {
  if (sender.isDestroyed()) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      ipcMain.removeListener('plugins:confirmImport', onDecision)
      sender.removeListener('destroyed', onCancel)
      sender.removeListener('render-process-gone', onCancel)
      sender.removeListener('did-start-navigation', onNavigate)
    }
    const finish = (accepted: boolean): void => { cleanup(); resolve(accepted) }
    const onCancel = (): void => finish(false)
    const onNavigate = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) onCancel()
    }
    const onDecision = (event: Electron.IpcMainEvent, id: unknown, accepted: unknown): void => {
      if (event.sender !== sender || id !== requestId) return
      finish(accepted === true)
    }
    ipcMain.on('plugins:confirmImport', onDecision)
    sender.once('destroyed', onCancel)
    sender.once('render-process-gone', onCancel)
    sender.on('did-start-navigation', onNavigate)
    try { sender.send('plugins:importPreview', requestId, preview) }
    catch (error) { cleanup(); reject(error) }
  })
}
