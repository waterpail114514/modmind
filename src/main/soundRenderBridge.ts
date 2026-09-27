import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { StudioDraft } from '../shared/soundStudio'
import { AUDIO_LIMIT } from './soundFiles'

export function renderMusicInWindow(window: BrowserWindow, draft: StudioDraft, signal?: AbortSignal): Promise<Buffer> {
  if (window.isDestroyed()) return Promise.reject(new Error('工作台窗口已关闭，无法渲染音乐'))
  signal?.throwIfAborted()
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('sounds:renderComplete', complete)
      signal?.removeEventListener('abort', abort)
      window.webContents.removeListener('destroyed', destroyed)
    }
    const complete = (event: Electron.IpcMainEvent, replyId: unknown, value: unknown, error: unknown): void => {
      if (event.sender !== window.webContents || replyId !== id) return
      cleanup()
      if (typeof error === 'string' && error) { reject(new Error(error)); return }
      if (!(value instanceof Uint8Array) || value.byteLength < 44 || value.byteLength > AUDIO_LIMIT) { reject(new Error('音乐渲染结果无效或过大')); return }
      const bytes = Buffer.from(value)
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') { reject(new Error('音乐渲染结果不是 WAV')); return }
      resolve(bytes)
    }
    const abort = (): void => { cleanup(); reject(new Error('音乐渲染已取消')) }
    const destroyed = (): void => { cleanup(); reject(new Error('工作台窗口已关闭，无法渲染音乐')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('音乐渲染超时，请缩短作品后重试')) }, 120000)
    ipcMain.on('sounds:renderComplete', complete)
    signal?.addEventListener('abort', abort, { once: true })
    window.webContents.once('destroyed', destroyed)
    window.webContents.send('sounds:renderRequest', { id, draft })
  })
}
