import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginChatBridge } from './pluginChatBridge'
import type { PluginChatSnapshot, PluginRecord, PluginWorkbenchRequest } from '../shared/plugins'

const plugin: PluginRecord = {
  manifest: { id: 'demo', name: 'Demo', version: '1.0.0', description: 'Demo', permissions: ['chat.context'] },
  enabled: true, directory: '/plugins/demo', scope: 'global', revision: 1
}
const current: PluginChatSnapshot = {
  projectPath: '/project', conversationId: 'one', title: 'One', busy: false, draft: '', messages: []
}

function setup() {
  const requests: PluginWorkbenchRequest[] = []
  const bridge = new PluginChatBridge(() => ({ id: 10, send: (request) => {
    requests.push(request)
    queueMicrotask(() => bridge.respond(10, request.target && request.target.conversationId !== current.conversationId
      ? { requestId: request.requestId, ok: false, error: '对话已切换' }
      : { requestId: request.requestId, ok: true, result: request.operation === 'getCurrent' ? current : { updated: true } }))
  } }))
  return { bridge, requests }
}

afterEach(() => vi.useRealTimers())

describe('plugin chat bridge', () => {
  it('adds and replaces context only in its project and conversation, without mixing plugin keys', async () => {
    const { bridge } = setup()
    await bridge.handle(plugin, 'chatSetContext', { key: 'facts', text: 'old' })
    await bridge.handle(plugin, 'chatSetContext', { key: 'facts', text: 'new' })
    const other = { ...plugin, manifest: { ...plugin.manifest, id: 'other' } }
    await bridge.handle(other, 'chatSetContext', { key: 'facts', text: 'other plugin' })
    expect(bridge.contextFor(current)).toContain('new')
    expect(bridge.contextFor(current)).not.toContain('old')
    expect(bridge.contextFor({ ...current, projectPath: '/elsewhere' })).toBe('')
    expect(bridge.contextFor({ ...current, conversationId: 'two' })).toBe('')
    await bridge.handle(plugin, 'chatRemoveContext', { key: 'facts' })
    expect(bridge.contextFor(current)).not.toContain('"plugin":"demo"')
    expect(bridge.contextFor(current)).toContain('other plugin')
  })

  it.each([
    { ...plugin, enabled: false },
    { ...plugin, error: 'invalid' },
    { ...plugin, revision: 2 },
    { ...plugin, directory: '/replacement' },
    { ...plugin, manifest: { ...plugin.manifest, permissions: [] } }
  ])('drops context when its owner is unavailable or replaced', async (replacement) => {
    const { bridge } = setup()
    await bridge.handle(plugin, 'chatSetContext', { key: 'facts', text: 'hello' })
    bridge.syncRecords([replacement])
    expect(bridge.contextFor(current)).toBe('')
  })

  it('rejects stale targets and invalid input before changing the destination', async () => {
    const { bridge } = setup()
    await expect(bridge.handle(plugin, 'chatSetContext', { key: 'facts', text: 'hello', target: { ...current, conversationId: 'two' } })).rejects.toThrow('对话已切换')
    await expect(bridge.handle(plugin, 'chatSetContext', { key: 'facts', text: 'a'.repeat(32001) })).rejects.toThrow('32000')
    await expect(bridge.handle(plugin, 'chatSetDraft', { text: 'hello', target: null })).rejects.toThrow('target')
    expect(bridge.contextFor(current)).toBe('')
  })

  it('preserves existing entries when a context would exceed the conversation limit', async () => {
    const { bridge } = setup()
    await bridge.handle(plugin, 'chatSetContext', { key: 'one', text: 'a'.repeat(32000) })
    await bridge.handle(plugin, 'chatSetContext', { key: 'two', text: 'b'.repeat(32000) })
    const before = bridge.contextFor(current)
    await expect(bridge.handle(plugin, 'chatSetContext', { key: 'three', text: 'x' })).rejects.toThrow('64000')
    expect(bridge.contextFor(current)).toBe(before)
  })

  it('defaults draft writes to append and forwards explicit replace and target', async () => {
    const { bridge, requests } = setup()
    await bridge.handle(plugin, 'chatSetDraft', { text: 'hello' })
    expect(requests[0]).toMatchObject({ operation: 'setDraft', text: 'hello', mode: 'append' })
    await bridge.handle(plugin, 'chatSetDraft', { text: '', mode: 'replace', target: current })
    expect(requests[1]).toMatchObject({ mode: 'replace', text: '', target: { projectPath: '/project', conversationId: 'one' } })
  })

  it('accepts responses only from the selected renderer', async () => {
    let request!: PluginWorkbenchRequest
    const bridge = new PluginChatBridge(() => ({ id: 10, send: (value) => { request = value } }))
    const result = bridge.handle(plugin, 'chatGetCurrent', {})
    bridge.respond(20, { requestId: request.requestId, ok: true, result: { ...current, draft: 'wrong window' } })
    bridge.respond(10, { requestId: request.requestId, ok: true, result: current })
    await expect(result).resolves.toEqual(current)
  })

  it('fails when the renderer is unavailable or stops responding', async () => {
    const missing = new PluginChatBridge(() => null)
    await expect(missing.handle(plugin, 'chatGetCurrent', {})).rejects.toThrow('不可用')
    vi.useFakeTimers()
    const bridge = new PluginChatBridge(() => ({ id: 10, send: () => {} }))
    const result = expect(bridge.handle(plugin, 'chatGetCurrent', {})).rejects.toThrow('未响应')
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  })
})
