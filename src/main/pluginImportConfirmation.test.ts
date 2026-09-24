import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PluginImportPreview } from '../shared/plugins'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
import { ipcMain } from 'electron'
import { requestPluginImportConfirmation } from './pluginImportConfirmation'

const preview: PluginImportPreview = { manifest: { id: 'asset-library', name: '资源素材库', version: '1.1.0', description: '', permissions: ['storage'] }, scope: 'project', fileName: 'assets.zip' }
function windowSender() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
}
afterEach(() => ipcMain.removeAllListeners())

describe('plugin import confirmation', () => {
  it('only accepts an explicit decision from the requesting window and request', async () => {
    const sender = windowSender()
    const result = requestPluginImportConfirmation(sender, 'request-1', preview)
    expect(sender.send).toHaveBeenCalledWith('plugins:importPreview', 'request-1', preview)
    ipcMain.emit('plugins:confirmImport', { sender: windowSender() }, 'request-1', true)
    ipcMain.emit('plugins:confirmImport', { sender }, 'other-request', true)
    expect(ipcMain.listenerCount('plugins:confirmImport')).toBe(1)
    ipcMain.emit('plugins:confirmImport', { sender }, 'request-1', true)
    expect(await result).toBe(true)
    expect(ipcMain.listenerCount('plugins:confirmImport')).toBe(0)
    expect(sender.eventNames()).toEqual([])
  })

  it.each([false, 'true', 1, undefined])('does not accept a non-true decision: %s', async accepted => {
    const sender = windowSender()
    const result = requestPluginImportConfirmation(sender, 'request-1', preview)
    ipcMain.emit('plugins:confirmImport', { sender }, 'request-1', accepted)
    expect(await result).toBe(false)
  })

  it.each(['destroyed', 'render-process-gone'])('cancels and removes listeners on %s', async event => {
    const sender = windowSender()
    const result = requestPluginImportConfirmation(sender, 'request-1', preview)
    sender.emit(event)
    expect(await result).toBe(false)
    expect(ipcMain.listenerCount('plugins:confirmImport')).toBe(0)
  })

  it('cancels on a page reload, but ignores iframe and in-page navigation', async () => {
    const sender = windowSender()
    const result = requestPluginImportConfirmation(sender, 'request-1', preview)
    sender.emit('did-start-navigation', {}, 'about:blank', false, false)
    sender.emit('did-start-navigation', {}, '#plugins', true, true)
    expect(ipcMain.listenerCount('plugins:confirmImport')).toBe(1)
    sender.emit('did-start-navigation', {}, 'about:blank', false, true)
    expect(await result).toBe(false)
  })
})
