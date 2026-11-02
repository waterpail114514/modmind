import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { GameControlActions } from '../../feature-plugins/testing/src/main/gameControlActions'
import type { BackgroundGameState } from '../../feature-plugins/testing/src/main/gameControlSession'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(family: 'glfw' | 'lwjgl2' | 'sdl' = 'glfw') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-game-actions-')); roots.push(directory)
  const sessionId = randomUUID()
  const state: BackgroundGameState = { protocol: 1, pid: 100, family, active: true, ready: true, frameId: 1, actionSequence: 0, width: 1920, height: 1080, logicalWidth: 960, logicalHeight: 540, lastPumpAgeMs: 0, keysDown: [], buttonsDown: [], hookClasses: 9, physicalCallbacksFiltered: true, error: null, coordinateRevision: `${sessionId}:1`, ownership: 'ai' }
  const image = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#227799' } }).png().toBuffer()
  const transport = { sessionId, status: vi.fn(async () => ({ ...state })), sync: vi.fn(async () => ({ ...state })), input: vi.fn(async (_action: unknown, _options: unknown) => ({ dispatched: true as const, actionSequence: ++state.actionSequence })),
    capture: vi.fn(async () => ({ ...state, frameId: ++state.frameId, capturedAt: Date.now(), mimeType: 'image/png' as const, image })), release: vi.fn(async () => {}),
    settle: vi.fn(async () => ({ settled: true as const, frameId: ++state.frameId, actionSequence: state.actionSequence })),
    ownership: vi.fn(async (owner: 'ai' | 'human' | 'paused') => { state.ownership = owner; return { ...state } }) }
  return { actions: new GameControlActions(transport, directory), transport, state }
}

describe('background game actions', () => {
  it('maps returned image pixels to logical coordinates with a render-thread geometry guard', async () => {
    const { actions, transport } = await fixture()
    const capture = await actions.capture()
    expect([capture.width, capture.height]).toEqual([1600, 900])
    const result = await actions.action({ operation: 'click', x: 800, y: 450, revision: capture.revision })
    expect(result).toMatchObject({ status: 'completed', acknowledged: true, gameplayVerified: false })
    expect(transport.input.mock.calls[0]).toEqual([{ type: 'move', x: 480, y: 270 }, expect.objectContaining({ coordinateRevision: transport.sessionId + ':1' })])
    expect(transport.settle).toHaveBeenCalledOnce()
  })

  it('rejects stale geometry and validates all coordinates before any batch input', async () => {
    const { actions, transport, state } = await fixture(); const capture = await actions.capture()
    const badBatch = await actions.action({ operation: 'batch', revision: capture.revision, steps: [{ operation: 'key', key: 'W' }, { operation: 'drag', x: 2, y: 2, toX: 1900, toY: 3 }] })
    expect(badBatch).toMatchObject({ status: 'failed' }); expect(transport.input).not.toHaveBeenCalled()
    state.coordinateRevision = transport.sessionId + ':2'
    expect(await actions.action({ operation: 'click', x: 10, y: 10, revision: capture.revision })).toMatchObject({ status: 'failed', error: expect.stringContaining('坐标已过期') })
    expect(transport.input).not.toHaveBeenCalled()
  })

  it('preserves screenshot coordinates across another viewer refresh, but rejects intervening input', async () => {
    const { actions, transport } = await fixture()
    const aiView = await actions.capture()
    await actions.capture() // The preview panel and the AI share this service.
    expect(await actions.action({ operation: 'click', x: 5, y: 5, revision: aiView.revision })).toMatchObject({ status: 'completed' })
    const next = await actions.capture()
    await actions.action({ operation: 'key', key: 'E', durationMs: 1 })
    const dispatched = transport.input.mock.calls.length
    expect(await actions.action({ operation: 'click', x: 5, y: 5, revision: next.revision })).toMatchObject({ status: 'failed', error: expect.stringContaining('坐标已过期') })
    expect(transport.input.mock.calls.length).toBe(dispatched)
  })

  it('expires issued screenshot coordinates even when no new viewer refresh occurs', async () => {
    const { actions, transport } = await fixture(), capturedAt = Date.now()
    const view = await actions.capture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 61000)
    try {
      expect(await actions.action({ operation: 'click', x: 5, y: 5, revision: view.revision })).toMatchObject({ status: 'failed', error: expect.stringContaining('坐标已过期') })
      expect(transport.input).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it('keeps a raw pointer down/move/up gesture usable across preview frames', async () => {
    const { actions } = await fixture(), view = await actions.capture()
    expect(await actions.action({ operation: 'button_down', button: 0, revision: view.revision, durationMs: 5000 })).toMatchObject({ status: 'completed' })
    await actions.capture()
    expect(await actions.action({ operation: 'move', x: 25, y: 30, revision: view.revision })).toMatchObject({ status: 'completed' })
    expect(await actions.action({ operation: 'button_up', button: 0, revision: view.revision })).toMatchObject({ status: 'completed' })
  })

  it.each(['glfw', 'lwjgl2', 'sdl'] as const)('normalizes keys and releases combos and batches (%s)', async family => {
    const { actions, transport } = await fixture(family)
    expect(await actions.action({ operation: 'combo', keys: ['Control', 'A'], durationMs: 1 })).toMatchObject({ status: 'completed' })
    expect(transport.input.mock.calls.map(call => call[0])).toEqual([
      { type: 'key', code: family === 'lwjgl2' ? 29 : 341, state: 'down', leaseMs: 1001 },
      { type: 'key', code: family === 'lwjgl2' ? 30 : 65, state: 'down', leaseMs: 1001 },
      { type: 'key', code: family === 'lwjgl2' ? 30 : 65, state: 'up' }, { type: 'key', code: family === 'lwjgl2' ? 29 : 341, state: 'up' }
    ])
    await actions.action({ operation: 'batch', steps: [{ operation: 'key_down', key: 'W', durationMs: 300 }, { operation: 'look', dx: 20, dy: -5 }, { operation: 'wait', durationMs: 10 }] })
    expect(transport.release).toHaveBeenCalledOnce()
  })

  it('deduplicates nested batch arguments, records completion and rejects changed retries', async () => {
    const { actions, transport } = await fixture(), requestId = randomUUID()
    const action = { requestId, operation: 'batch', steps: [{ operation: 'key', key: 'W', durationMs: 1 }] }
    const first = await actions.action(action); expect(await actions.action(action)).toEqual(first)
    await expect(actions.action({ ...action, steps: [{ operation: 'key', key: 'S', durationMs: 1 }] })).rejects.toThrow('不同动作')
    expect(transport.input).toHaveBeenCalledTimes(2)
    expect(actions.result(requestId)).toMatchObject({ status: 'completed', completedSteps: 1 })
  })

  it('does not acknowledge a render-thread callback failure after dispatch', async () => {
    const { actions, transport, state } = await fixture()
    transport.settle.mockImplementation(async () => {
      state.error = 'callback dispatch: local connection failed'
      return { settled: true, frameId: ++state.frameId, actionSequence: state.actionSequence }
    })
    expect(await actions.action({ operation: 'key', key: 'W', durationMs: 1 })).toMatchObject({ status: 'failed', acknowledged: false, error: state.error })
    expect(transport.release).toHaveBeenCalledOnce()
  })

  it('cancels a held-key batch and queued actions without waiting behind the batch', async () => {
    const { actions, transport } = await fixture()
    const first = actions.action({ operation: 'batch', steps: [{ operation: 'key_down', key: 'W', durationMs: 4000 }, { operation: 'wait', durationMs: 4000 }] })
    await vi.waitFor(() => expect(transport.input).toHaveBeenCalledOnce())
    const queued = actions.action({ operation: 'key', key: 'S' })
    await actions.cancel()
    expect(await first).toMatchObject({ status: 'cancelled' }); expect(await queued).toMatchObject({ status: 'cancelled' })
    expect(transport.input).toHaveBeenCalledTimes(1)
    expect(transport.release).toHaveBeenCalled()
  })

  it('rejects actions during human ownership and requires a new screenshot after resuming', async () => {
    const { actions, transport } = await fixture(); const capture = await actions.capture()
    expect(await actions.ownership('human')).toMatchObject({ ownership: 'human' })
    expect(await actions.action({ operation: 'key', key: 'W' })).toMatchObject({ status: 'failed' })
    expect(transport.input).not.toHaveBeenCalled()
    await actions.ownership('ai')
    expect(await actions.action({ operation: 'click', x: 3, y: 3, revision: capture.revision })).toMatchObject({ status: 'failed' })
  })

  it('returns a later actual capture and does not label input completion as gameplay success', async () => {
    const { actions } = await fixture(); const result = await actions.action({ operation: 'text', text: '中文 test', capture: true })
    expect(result).toMatchObject({ status: 'completed', gameplayVerified: false, captures: [expect.objectContaining({ mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png;base64,/), revision: expect.any(String) })] })
  })
})
