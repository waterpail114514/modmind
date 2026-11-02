import { describe, expect, it } from 'vitest'
import type { AiOutputEvent, ConversationEventRecord, InspirationChatMessage, PipelineEvent } from '../../shared/types'
import { inspirationActivityRows } from './inspirationActivity'
import { inspirationProgressOutput, settleInspirationProgress } from './inspirationProgress'
import { replayInspirationEvents, upsertInspirationNotice, upsertInspirationProgress } from './inspirationOutput'
import { normalizeStoredInspirationMessages } from './inspirationStorage'

const progress = (sequence: number, title: string, status: PipelineEvent['status'] = 'running'): PipelineEvent => ({
  id: `p${sequence}`, eventId: `p${sequence}`, sequence, stage: 'planning', title, detail: `${title}详情`, status,
  time: `2026-10-28T10:00:${String(sequence).padStart(2, '0')}Z`, sessionId: 'session', turnId: 'turn', conversationId: 'idea', generation: 2
})
const record = (payload: PipelineEvent | AiOutputEvent, sequence: number, kind: 'progress' | 'output'): ConversationEventRecord => ({
  eventId: `e${sequence}`, conversationId: 'idea', generation: 2, turnId: 'turn', sequence, kind, time: payload.time, payload
})

describe('inspiration host progress', () => {
  it('keeps distinct stages visible and only ends earlier host stages', () => {
    const native: InspirationChatMessage = { role: 'assistant', kind: 'tool', content: '读取文件', sessionId: 'session', activity: { kind: 'tool', title: '读取文件', status: 'running', startedAt: 'T' } }
    let live = upsertInspirationProgress([native], progress(1, '检查工具'))
    live = upsertInspirationProgress(live, progress(2, '恢复会话'))
    expect(live.map(message => message.content)).toEqual(['读取文件', '检查工具', '恢复会话'])
    expect(live[0].activity?.status).toBe('running')
    expect(live[1].activity?.status).toBe('completed')
    expect(live[2].activity?.status).toBe('running')
    const settled = settleInspirationProgress(live, 'session')
    expect(settled[2].activity?.status).toBe('completed')
    expect(settled[0].activity?.status).toBe('running')
  })

  it('updates repeated stages and ignores duplicate or late lifecycle events', () => {
    const event = progress(1, '检查工具')
    const live = upsertInspirationProgress([], event)
    const complete = upsertInspirationProgress(live, progress(3, '检查工具', 'success'))
    expect(complete).toHaveLength(1)
    expect(complete[0].activity?.status).toBe('completed')
    expect(upsertInspirationProgress(complete, event)).toBe(complete)
    const retry = upsertInspirationProgress(complete, progress(4, '检查工具'))
    expect(retry).toHaveLength(1)
    expect(retry[0].activity?.status).toBe('running')
  })

  it('replays host progress and native output in one recoverable history', () => {
    const events = [record(progress(1, '检查工具'), 1, 'progress'), record(progress(2, '恢复会话'), 2, 'progress'),
      record({ kind: 'answer', content: '回答完成', time: '2026-10-28T10:00:03Z', sessionId: 'session', turnId: 'turn' }, 3, 'output')]
    const replay = replayInspirationEvents([], events)
    expect(replay.map(message => message.content)).toEqual(['检查工具', '恢复会话', '回答完成'])
    expect(replay.slice(0, 2).every(message => message.activity?.status === 'completed')).toBe(true)
    const restored = normalizeStoredInspirationMessages(JSON.parse(JSON.stringify(replay)))
    expect(replayInspirationEvents(restored, events)).toEqual(restored)
  })

  it('shows retry as a warning and merges progress/output notices into one row', () => {
    const event = { ...progress(2, '等待重连', 'warning'), notice: { key: 'retry' as const, detail: '8 秒后重试', occurrences: 1 } }
    const live = upsertInspirationProgress([], event)
    expect(live[0]).toMatchObject({ kind: 'tool', status: 'warning', notice: { key: 'retry' } })
    const output = { ...inspirationProgressOutput(event), sequence: 3, content: '正在重试', notice: { ...event.notice, occurrences: 2 } }
    const updated = upsertInspirationNotice(live, output)
    expect(updated).toHaveLength(1)
    expect(inspirationActivityRows(updated)[0]).toMatchObject({ status: 'warning', content: '正在重试' })
    expect(replayInspirationEvents([], [record(event, 2, 'progress'), record(output, 3, 'output')])).toMatchObject([{ status: 'warning', notice: { occurrences: 2 } }])
    expect(normalizeStoredInspirationMessages([{ ...updated[0], status: 'completed' }])[0].status).toBe('warning')
  })

  it('does not settle progress belonging to another session', () => {
    const live = upsertInspirationProgress([], progress(1, '检查工具'))
    expect(settleInspirationProgress(live, 'other-session')).toBe(live)
  })

  it('backfills missing stages in an old saved view without losing edited artifacts', () => {
    const view: InspirationChatMessage[] = [
      { role: 'user', content: '提问', turnId: 'turn', sequence: 1 },
      { role: 'assistant', kind: 'tool', content: '读取知识', turnId: 'turn', sessionId: 'session', sequence: 4 },
      { role: 'assistant', content: '已回答', promptEdit: '用户编辑提示词', turnId: 'turn', sessionId: 'session', sequence: 6, status: 'completed', isFinal: true }
    ]
    const events = [record(progress(2, '检查工具'), 2, 'progress'), record(progress(3, '恢复会话'), 3, 'progress')]
    const restored = replayInspirationEvents(view, events)
    expect(restored.map(message => message.content)).toEqual(['提问', '检查工具', '恢复会话', '读取知识', '已回答'])
    expect(restored.at(-1)?.promptEdit).toBe('用户编辑提示词')
    expect(restored.filter(message => message.activity).every(message => message.activity?.status === 'completed')).toBe(true)
    expect(replayInspirationEvents(restored, events)).toEqual(restored)
  })
})
