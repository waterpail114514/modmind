import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { BackgroundMinecraftTestService } from '../../feature-plugins/testing/src/main/backgroundMinecraftTestService'
import type { ProjectInfo } from '../shared/types'
import { gameControlMcpFixture } from './__fixtures__/gameControlMcp'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const data = (response: any) => {
  if (response.error) throw new Error(JSON.stringify(response.error))
  const text = response.result?.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')
  try { return JSON.parse(text) } catch { return text }
}
async function fixture(options: Parameters<typeof gameControlMcpFixture>[2] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-game-mcp-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  let project = { name: 'MCP owned game', path: root, loader: 'fabric', minecraftVersion: '1.20.1', kind: 'mod' } as ProjectInfo
  const sessionId = randomUUID(), image = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#345678' } }).png().toBuffer()
  const state = { family: 'glfw', ownership: 'ai', ready: true, active: true, coordinateRevision: sessionId + ':1', width: 640, height: 360, logicalWidth: 640, logicalHeight: 360, actionSequence: 0, frameId: 1 }
  let running = false
  const transport = { sessionId, assertProject: () => {}, waitUntilReady: async () => state, status: async () => state, sync: async () => state,
    input: vi.fn(async () => ({ dispatched: true, actionSequence: ++state.actionSequence })), release: vi.fn(async () => {}),
    capture: async () => ({ ...state, frameId: ++state.frameId, capturedAt: Date.now(), image }), settle: async () => ({ settled: true, frameId: ++state.frameId }),
    ownership: async (owner: string) => { state.ownership = owner; return state } }
  const service = new BackgroundMinecraftTestService({ currentProject: () => project, build: async () => { throw new Error('fixture must not build') },
    createRuntime: () => ({ getState: () => ({ running }), launch: async () => { running = true }, stop: async () => { running = false }, getBackgroundGameControl: () => transport }) as never })
  const mcp = await gameControlMcpFixture(() => project, service, options); cleanups.push(mcp.close)
  return { mcp, service, transport, project, setProject: (value: ProjectInfo) => { project = value } }
}

it.each([false, true])('discovers schemas and completes stdio -> workbench feature -> shared service -> MCP image (%s standalone)', async standalone => {
  const { mcp, transport } = await fixture({ standalone })
  const tools = (await mcp.list()).result.tools
  expect(tools.find((tool: any) => tool.name === 'modmind_test_action').inputSchema.properties.operation.enum).toContain('drag')
  const start = data(await mcp.call('session', { operation: 'start', mode: 'rendered', withoutProjectMod: true }))
  expect(start.sessionId).toBeTruthy()
  expect(data(await mcp.call('session', { operation: 'state', sessionId: start.sessionId, waitSeconds: 1 }))).toMatchObject({ ready: true, backend: 'background-agent' })
  const capture = await mcp.call('capture', { sessionId: start.sessionId }), view = data(capture).captures[0]
  expect(capture.result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png', data: expect.any(String) }))
  expect(JSON.stringify(data(capture))).not.toContain('base64,')
  const requestId = randomUUID(), input = { operation: 'click', sessionId: start.sessionId, revision: view.revision, requestId, x: 320, y: 180, capture: true }
  expect(data(await mcp.call('action', input))).toMatchObject({ status: 'completed', acknowledged: true, gameplayVerified: false })
  const dispatched = transport.input.mock.calls.length
  expect(data(await mcp.call('action', input))).toMatchObject({ status: 'completed' })
  expect(transport.input).toHaveBeenCalledTimes(dispatched)
  expect(data(await mcp.call('observe', { sessionId: start.sessionId, operation: 'result', requestId }))).toMatchObject({ status: 'completed' })
  const invalid = await mcp.call('action', { ...input, x: -1, requestId: randomUUID() })
  expect(invalid.result?.isError || invalid.error).toBeTruthy(); expect(transport.input).toHaveBeenCalledTimes(dispatched)
  mcp.setAuthorized(false)
  const denied = await mcp.call('action', { sessionId: start.sessionId, operation: 'key', key: 'W' })
  expect(denied.result?.isError || denied.error).toBeTruthy(); expect(transport.input).toHaveBeenCalledTimes(dispatched)
}, 45000)

it('enforces the rendered feature switch while allowing cleanup', async () => {
  const { mcp, service, project, transport } = await fixture({ rendered: false })
  const start = await service.execute(project, 'session', { operation: 'start', mode: 'rendered', withoutProjectMod: true }) as { sessionId: string }
  await service.execute(project, 'session', { operation: 'state', sessionId: start.sessionId, waitSeconds: 1 })
  const action = await mcp.call('action', { sessionId: start.sessionId, operation: 'key', key: 'W' })
  expect(action.result?.isError || action.error).toBeTruthy(); expect(transport.input).not.toHaveBeenCalled()
  expect(data(await mcp.call('action', { sessionId: start.sessionId, operation: 'release' }))).toMatchObject({ cancelled: true })
  expect(data(await mcp.call('session', { sessionId: start.sessionId, operation: 'takeover' }))).toMatchObject({ ownership: 'human' })
}, 45000)

it('rejects read-only mutation and stale project calls before transport input', async () => {
  const { mcp, transport, setProject, project } = await fixture({ readOnly: true })
  const response = await mcp.call('session', { operation: 'start', mode: 'rendered', withoutProjectMod: true })
  expect(response.result?.isError || response.error).toBeTruthy(); expect(transport.input).not.toHaveBeenCalled()
  setProject({ ...project, path: project.path + '-new' })
  const stale = await mcp.call('action', { sessionId: 'old', operation: 'key', key: 'W' })
  expect(stale.result?.isError || stale.error).toBeTruthy(); expect(transport.input).not.toHaveBeenCalled()
}, 45000)

it('keeps a writable MCP bridge bound to its original project after the UI switches projects', async () => {
  const { mcp, transport, setProject, project } = await fixture()
  setProject({ ...project, path: project.path + '-new' })
  const response = await mcp.call('session', { operation: 'start', mode: 'rendered', withoutProjectMod: true })
  expect(response.result?.isError || response.error).toBeTruthy()
  expect(transport.input).not.toHaveBeenCalled()
}, 45000)
