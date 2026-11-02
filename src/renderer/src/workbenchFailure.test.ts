import { describe, expect, it } from 'vitest'
import { appendUserTurn, appendWorkbenchFailure, normalizeStoredWorkbenchTimeline, reduceWorkbenchOutput } from './workbenchTimeline'

describe('workbench failures before backend output', () => {
  it('keeps the user request and a visible terminal preparation error through history serialization', () => {
    const initial = appendUserTurn([], '制作一把剑', 'prepare-1')
    const failed = appendWorkbenchFailure(initial, '任务未能开始：无法读取供应商模型列表（网络请求超时）', 'prepare-1')
    expect(failed).toHaveLength(2)
    expect(failed[0]).toEqual(initial[0])
    expect(failed[1]).toMatchObject({ kind: 'error', terminal: true, status: 'error', turnId: 'turn-prepare-1' })
    expect(JSON.parse(JSON.stringify(failed)).map(normalizeStoredWorkbenchTimeline)).toEqual(failed)
    expect(appendWorkbenchFailure(failed, 'another IPC rejection', 'prepare-1')).toEqual(failed)
  })

  it('keeps an explicit terminal error terminal even when its recovery advice says to retry', () => {
    const failed = appendWorkbenchFailure([], '任务未能开始：无法读取供应商模型列表（网络请求超时），请检查网络后重试', 'prepare-2')
    expect(JSON.parse(JSON.stringify(failed)).map(normalizeStoredWorkbenchTimeline)[0]).toMatchObject({ kind: 'error', terminal: true, recoverable: false })
  })

  it('keeps errors from earlier turns while allowing a subsequent retry to complete', () => {
    const failed = appendWorkbenchFailure(appendUserTurn([], '制作一把剑', 'first'), '无法读取供应商模型列表', 'first')
    const retry = appendUserTurn(failed, '制作一把剑', 'retry')
    const completed = reduceWorkbenchOutput(retry, { kind: 'answer', content: '已完成', sessionId: 'retry', turnId: 'turn-retry', time: new Date().toISOString() })
    expect(completed.filter(item => item.kind === 'error')).toHaveLength(1)
    expect(completed.at(-1)).toMatchObject({ kind: 'answer', content: '已完成' })
  })

  it('retains a backend terminal error without adding a second notice for its IPC rejection', () => {
    const emitted = reduceWorkbenchOutput([], { kind: 'error', content: 'AI 凭证无效', turnId: 'turn-request', time: new Date().toISOString(), terminal: true })
    expect(appendWorkbenchFailure(emitted, 'invoke rejected', 'request')).toEqual(emitted)
  })
})
