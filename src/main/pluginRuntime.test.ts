import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PluginRuntime } from './pluginRuntime'
import { pluginMcpToolName, parsePluginMcpToolName } from '../shared/plugins'
import type { PluginRecord } from '../shared/plugins'

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    manifest: {
      id: 'demo',
      name: 'Demo',
      version: '0.1.0',
      description: 'demo',
      permissions: ['project.read', 'storage'],
      backend: {
        entry: 'backend/main.mjs',
        tools: [
          { name: 'list_things', description: 'lists things read-only', annotations: { readOnlyLocal: true } },
          { name: 'do_heavy', description: 'heavy managed op', annotations: { managedAction: true } }
        ]
      }
    },
    scope: 'global',
    directory: '/tmp/demo',
    enabled: true,
    ...overrides
  }
}

describe('PluginRuntime tool descriptors', () => {
  it('builds MCP namespaced descriptors only for healthy enabled backends', () => {
    const runtime = new PluginRuntime({ hostScriptPath: '/host.mjs', dataRootDirectory: '/data', projectInfo: () => null })
    runtime.syncRecords(new Map([
      ['demo', record()],
      ['disabled', record({ manifest: { id: 'disabled', name: 'D', version: '0.1.0', description: '', permissions: [], backend: { entry: 'x.mjs', tools: [{ name: 't', description: 'tool' }] } }, enabled: false })],
      ['broken', record({ manifest: { id: 'broken', name: 'B', version: '0.1.0', description: '', permissions: [], backend: { entry: 'x.mjs', tools: [{ name: 't2', description: 'tool' }] } }, error: 'missing entry' })]
    ]))

    const names = runtime.listToolDescriptors().map((d) => d.name)
    expect(names).toEqual([pluginMcpToolName('demo', 'list_things'), pluginMcpToolName('demo', 'do_heavy')])
  })

  it('round-trips tool names through shared helpers', () => {
    const parsed = parsePluginMcpToolName(pluginMcpToolName('my-plugin', 'my_tool'))
    expect(parsed).toEqual({ pluginId: 'my-plugin', toolName: 'my_tool' })
    expect(parsePluginMcpToolName('modmind_build_project')).toBeUndefined()
    expect(parsePluginMcpToolName('modmind_plugin_nounderscore')).toBeUndefined()
  })

  it('gates read-only mode to readOnly* annotated tools', () => {
    const runtime = new PluginRuntime({ hostScriptPath: '/host.mjs', dataRootDirectory: '/data', projectInfo: () => null })
    runtime.syncRecords(new Map([['demo', record()]]))

    const readOnly = runtime.findTool(pluginMcpToolName('demo', 'list_things'))
    const heavy = runtime.findTool(pluginMcpToolName('demo', 'do_heavy'))
    expect(readOnly && PluginRuntime.isReadOnlyAllowed(readOnly.descriptor)).toBe(true)
    expect(heavy && PluginRuntime.isReadOnlyAllowed(heavy.descriptor)).toBe(false)
  })

  it('rejects calls to disabled or unknown plugins without spawning a host', async () => {
    const runtime = new PluginRuntime({ hostScriptPath: '/host.mjs', dataRootDirectory: '/data', projectInfo: () => null })
    runtime.syncRecords(new Map())
    await expect(runtime.callTool('demo', 'list_things', {})).rejects.toThrow('未找到插件')
    await expect(runtime.handleContextOp('demo', 'projectInfo', {})).rejects.toThrow('插件不可用')
  })

  it('enforces per-permission context ops', async () => {
    const runtime = new PluginRuntime({
      hostScriptPath: '/host.mjs',
      dataRootDirectory: '/data',
      projectInfo: () => ({ name: 'p', path: '/p', kind: 'mod' })
    })
    runtime.syncRecords(new Map([
      ['noperm', record({ manifest: { id: 'noperm', name: 'N', version: '0.1.0', description: '', permissions: [] } })]
    ]))
    await expect(runtime.handleContextOp('noperm', 'projectInfo', {})).rejects.toThrow('缺少权限')
    await expect(runtime.handleContextOp('noperm', 'unknownOp', {})).rejects.toThrow('未知上下文操作')
  })

  it('checks host permissions and binds UI operations to the calling plugin', async () => {
    const hostContextOp = vi.fn(async () => ({ updated: true }))
    const runtime = new PluginRuntime({ hostScriptPath: '/host.mjs', dataRootDirectory: '/data', projectInfo: () => null, hostContextOp })
    const enabled = record({ manifest: { ...record().manifest, permissions: ['ui.overlay', 'chat.context'] } })
    runtime.syncRecords(new Map([['demo', enabled]]))
    await expect(runtime.handleContextOp('demo', 'chatGetCurrent', {})).rejects.toThrow('chat.read')
    await expect(runtime.handleContextOp('demo', 'chatSetDraft', {})).rejects.toThrow('chat.write')
    expect(hostContextOp).not.toHaveBeenCalled()
    await runtime.handleContextOp('demo', 'overlayClose', { pluginId: 'other' })
    expect(hostContextOp).toHaveBeenLastCalledWith(enabled, 'overlayClose', { pluginId: 'other' })
    await runtime.handleContextOp('demo', 'chatSetContext', { key: 'facts', text: 'hello' })
    expect(hostContextOp).toHaveBeenCalledTimes(2)
    runtime.syncRecords(new Map([['demo', { ...enabled, enabled: false }]]))
    await expect(runtime.handleContextOp('demo', 'chatSetContext', {})).rejects.toThrow('插件不可用')
  })

  it('round-trips call ids and host context requests', async () => {
    class FakeHost extends EventEmitter {
      sent: Array<Record<string, unknown>> = []
      callId = ''
      killed = false

      postMessage(message: Record<string, unknown>): void {
        this.sent.push(message)
        if (message.kind === 'call') {
          this.callId = String(message.id ?? '')
          queueMicrotask(() => this.emit('message', { id: 'ctx-1', kind: 'ctx', op: 'projectInfo', args: {} }))
        } else if (message.kind === 'ctx' && message.id === 'ctx-1') {
          queueMicrotask(() => this.emit('message', { id: this.callId, ok: true, result: { project: message.result } }))
        }
      }

      kill(): void {
        this.killed = true
      }
    }

    const child = new FakeHost()
    const runtime = new PluginRuntime({
      hostScriptPath: '/host.mjs',
      dataRootDirectory: '/data',
      projectInfo: () => ({ name: 'demo-project', path: '/project', kind: 'mod' }),
      forkHost: (() => {
        queueMicrotask(() => child.emit('message', { kind: 'ready', registeredTools: ['list_things', 'do_heavy'] }))
        return child
      }) as never
    })
    runtime.syncRecords(new Map([['demo', record()]]))

    await expect(runtime.callTool('demo', 'list_things', { value: 1 })).resolves.toEqual({
      project: { name: 'demo-project', path: '/project', kind: 'mod' }
    })
    expect(child.callId).not.toBe('')
    expect(child.sent[0]).toMatchObject({ id: child.callId, kind: 'call', tool: 'list_things', input: { value: 1 } })
    expect(child.sent[1]).toMatchObject({ id: 'ctx-1', kind: 'ctx', ok: true })
    expect(runtime.getDiagnostics('demo')).toMatchObject({ status: 'running' })
    expect(runtime.getDiagnostics('demo').logs.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      '调用工具 list_things',
      expect.stringContaining('工具 list_things 完成')
    ]))
    expect(runtime.clearDiagnostics('demo').logs).toEqual([])
    runtime.syncRecords(new Map([['demo', record({ revision: 1 })]]))
    expect(child.killed).toBe(true)
  })

  it('executes configured network and clipboard bridge capabilities', async () => {
    let clipboard = ''
    const runtime = new PluginRuntime({
      hostScriptPath: '/host.mjs',
      dataRootDirectory: '/data',
      projectInfo: () => null,
      clipboardWrite: (text) => { clipboard = text },
      netFetch: (async () => new Response('ok', { status: 201, headers: { 'x-test': 'yes' } })) as typeof fetch
    })
    runtime.syncRecords(new Map([['demo', record({ manifest: { ...record().manifest, permissions: ['net.fetch', 'clipboard.write'] } })]]))

    await expect(runtime.handleContextOp('demo', 'clipboardWrite', { text: 'copied' })).resolves.toEqual({ written: true })
    expect(clipboard).toBe('copied')
    await expect(runtime.handleContextOp('demo', 'netFetch', { url: 'https://example.com' })).resolves.toMatchObject({ status: 201, body: 'ok' })
  })
})
