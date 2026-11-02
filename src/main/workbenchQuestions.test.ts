import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchQuestions, WORKBENCH_QUESTION_WAIT_MS } from './workbenchQuestions'
import type { AgentQuestionAnswers } from '../shared/agentQuestion'

const context = { projectPath: 'C:/project', conversationId: 'conversation', runId: 'run' }
const questions = [{ id: 'style', header: '风格', question: '用哪种风格？', isSecret: false, options: [{ label: '简洁', description: '' }] }]

function setup() {
  vi.useFakeTimers()
  const changed = vi.fn()
  const store = new WorkbenchQuestions(changed)
  const lifetime = new AbortController()
  const waiting = new AbortController()
  const replies: AgentQuestionAnswers[] = []
  const reply = vi.fn((answers: AgentQuestionAnswers) => {
    if (waiting.signal.aborted || lifetime.signal.aborted) return false
    replies.push(answers)
    waiting.abort()
    return true
  })
  const steer = vi.fn(async (_text: string): Promise<void> => undefined)
  store.add(1, context, questions, lifetime.signal, { reply, waiting: waiting.signal, steer })
  const request = store.list(1)[0]
  return { store, request, changed, lifetime, waiting, replies, reply, steer }
}

afterEach(() => vi.useRealTimers())

describe('workbench bounded question wait', () => {
  it('waits exactly 20 seconds, returns no choice, and keeps late answering available', async () => {
    const { store, request, replies, steer } = setup()
    expect(request.replyBy).toBe(Date.now() + WORKBENCH_QUESTION_WAIT_MS)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(replies).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(replies).toEqual([{}])
    expect(store.list(1)).toHaveLength(1)
    expect(request.replyBy).toBeUndefined()
    await store.answer(1, request, { style: '简洁' })
    expect(steer).toHaveBeenCalledWith(expect.stringContaining('回答：简洁'))
    expect(replies).toEqual([{}])
    expect(store.list(1)).toEqual([])
  })

  it('submits a timely answer through the original native request, without steering or a later empty reply', async () => {
    const { store, request, replies, steer } = setup()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(await store.answer(1, request, { style: ' 简洁 ' })).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(replies).toEqual([{ style: '简洁' }])
    expect(steer).not.toHaveBeenCalled()
    await expect(store.answer(1, request, { style: '简洁' })).rejects.toThrow('已结束')
  })

  it('keeps inspiration questions isolated and allows late replies after their deadline', async () => {
    const { store, lifetime } = setup()
    const reply = vi.fn(() => true)
    const steer = vi.fn(async (_text: string): Promise<void> => undefined)
    store.add(1, { ...context, runId: 'inspiration-run', surface: 'inspiration' }, questions, lifetime.signal, { reply, steer })
    const request = store.list(1).find(item => item.surface === 'inspiration')!
    await expect(store.answer(1, { ...request, surface: 'workspace' }, { style: '简洁' })).rejects.toThrow('已结束')
    expect(store.dismiss(1, { ...request, surface: 'workspace' })).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reply).toHaveBeenCalledExactlyOnceWith({})
    await store.answer(1, request, { style: '简洁' })
    expect(steer).toHaveBeenCalledWith(expect.stringContaining('简洁'))
    expect(store.list(1)).toHaveLength(1)
  })

  it('treats a submission at the deadline as a late answer even if the timer callback is delayed', async () => {
    const { store, request, replies, steer } = setup()
    vi.setSystemTime(request.replyBy!)
    await store.answer(1, request, { style: '简洁' })
    expect(replies).toEqual([{}])
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('ends the countdown if Codex resolves early, preserving late answers', async () => {
    const { store, request, replies, waiting, steer } = setup()
    waiting.abort()
    expect(request.replyBy).toBeUndefined()
    await store.answer(1, request, { style: '简洁' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(steer).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([])
  })

  it('validates window, project, conversation, run and answer contents before replying', async () => {
    const { store, request, replies } = setup()
    expect(store.list(2)).toEqual([])
    for (const [owner, other] of [[2, request], [1, { ...request, projectPath: 'other' }], [1, { ...request, conversationId: 'other' }], [1, { ...request, runId: 'other' }], [1, { ...request, surface: 'inspiration' }]] as const) {
      await expect(store.answer(owner, other, { style: '简洁' })).rejects.toThrow('已结束')
      expect(store.dismiss(owner, other)).toBe(false)
    }
    for (const answers of [{}, { unknown: 'yes' }, { style: ['yes'] }, { style: 'x'.repeat(16_001) }]) await expect(store.answer(1, request, answers)).rejects.toThrow()
    expect(replies).toEqual([])
  })

  it('allows dismissing immediately, and clears timers on task cancellation or window destruction', async () => {
    const { store, request, replies } = setup()
    expect(store.dismiss(1, request)).toBe(true)
    expect(replies).toEqual([{}])
    expect(vi.getTimerCount()).toBe(0)
    const next = setup()
    next.lifetime.abort()
    expect(next.store.list(1)).toMatchObject([{ ended: true }])
    expect(next.replies).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(next.store.dismiss(2, next.request)).toBe(false)
    expect(next.store.dismiss(1, next.request)).toBe(true)
    expect(next.store.list(1)).toEqual([])
    const another = setup()
    another.store.cancelOwner(1)
    expect(another.store.list(1)).toEqual([])
    expect(another.replies).toEqual([{}])
  })

  it('retains failed late answers for retry, suppresses duplicates, and does not wait for already asynchronous questions', async () => {
    const { store, lifetime } = setup()
    store.cancelOwner(1)
    let release!: () => void
    const steer = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    store.add(1, context, questions, lifetime.signal, { steer })
    const request = store.list(1)[0]
    expect(request.replyBy).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    await expect(store.answer(1, request, { style: '简洁' })).rejects.toThrow('连接中断')
    expect(store.list(1)).toHaveLength(1)
    const answer = store.answer(1, request, { style: '简洁' })
    expect(await store.answer(1, request, { style: '简洁' })).toBe(false)
    release()
    expect(await answer).toBe(true)
  })

  it('removes the retained snapshot when a late answer succeeds while the native turn is finishing', async () => {
    const { store, request, lifetime, steer } = setup()
    await vi.advanceTimersByTimeAsync(WORKBENCH_QUESTION_WAIT_MS)
    let release!: () => void
    steer.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const answering = store.answer(1, request, { style: '简洁' })
    lifetime.abort()
    expect(store.list(1)).toMatchObject([{ ended: true }])
    release()
    expect(await answering).toBe(true)
    expect(store.list(1)).toEqual([])
  })
})
