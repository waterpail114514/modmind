import { describe, expect, it } from 'vitest'
import {
  createWorkbenchConversation,
  formatConversationTime,
  isLegacyWorkbenchConversation,
  isValidWorkbenchConversationId,
  migrateLegacyConversation,
  normalizeWorkbenchConversations,
  removeWorkbenchConversation,
  sortWorkbenchConversations,
  titleFromUserText,
  touchWorkbenchConversation,
  workbenchPromptHistoryStorageKey,
  workbenchSessionScope
} from './workbenchConversations'

describe('workbench conversations', () => {
  it('keeps pinned conversations above newer unpinned ones after reload', () => {
    const stored = normalizeWorkbenchConversations([
      { id: 'ws-old', title: '旧对话', createdAt: '2026-01-01', updatedAt: '2026-01-01', pinned: true, titleSource: 'manual' },
      { id: 'ws-new', title: '新对话', createdAt: '2026-02-01', updatedAt: '2026-02-01' }
    ])
    expect(sortWorkbenchConversations(stored).map(item => item.id)).toEqual(['ws-old', 'ws-new'])
    expect(stored[0]).toMatchObject({ pinned: true, titleSource: 'manual' })
  })
  it('keeps beginner identity in the compatibility index after reload and title changes', () => {
    const created = createWorkbenchConversation([], new Date(), 'beginner')
    const loaded = normalizeWorkbenchConversations(JSON.parse(JSON.stringify(created.conversations)))
    expect(loaded[0].agentMode).toBe('beginner')
    expect(touchWorkbenchConversation(loaded, loaded[0].id, { title: '新标题' })[0].agentMode).toBe('beginner')
    expect(createWorkbenchConversation().conversation.agentMode).toBeUndefined()
  })
  it('creates unique ids that are safe as path segments', () => {
    const { conversations, conversation } = createWorkbenchConversation([])
    expect(conversations).toContainEqual(conversation)
    expect(isValidWorkbenchConversationId(conversation.id)).toBe(true)
    expect(workbenchSessionScope(conversation.id)).toBe(`workspace/${conversation.id}`)
  })

  it('isolates prompt repetition history by conversation', () => {
    const first = { id: 'ws-a', sessionScope: 'workspace/ws-a' }
    const second = { id: 'ws-b', sessionScope: 'workspace/ws-b' }
    expect(workbenchPromptHistoryStorageKey('C:/project', first)).not.toBe(workbenchPromptHistoryStorageKey('C:/project', second))
    expect(workbenchPromptHistoryStorageKey('C:/project', { id: 'workspace', sessionScope: 'workspace' }))
      .toBe('modmind-workspace-prompts:C:/project')
  })

  it('orders conversations by recency after touching', () => {
    const a = { id: 'ws-a', title: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionScope: 'workspace/ws-a' }
    const b = { id: 'ws-b', title: 'B', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sessionScope: 'workspace/ws-b' }
    const touched = touchWorkbenchConversation([a, b], 'ws-a')
    expect(touched[0].id).toBe('ws-a')
    expect(touched[0].updatedAt > b.updatedAt).toBe(true)
  })

  it('removes conversations without mutating the input', () => {
    const a = { id: 'ws-a', title: 'A', createdAt: '', updatedAt: '', sessionScope: 'workspace/ws-a' }
    const b = { id: 'ws-b', title: 'B', createdAt: '', updatedAt: '', sessionScope: 'workspace/ws-b' }
    const rest = removeWorkbenchConversation([a, b], 'ws-a')
    expect(rest.map((item) => item.id)).toEqual(['ws-b'])
  })

  it('keeps the full first message as the title', () => {
    expect(titleFromUserText('  给我\n加一个 血量显示  ')).toBe('给我 加一个 血量显示')
    expect(titleFromUserText(`${'x'.repeat(120)}结尾`)).toBe(`${'x'.repeat(120)}结尾`)
    expect(titleFromUserText('')).toBe('新的对话')
  })

  it('formats relative conversation times', () => {
    const now = new Date('2026-08-06T12:00:00')
    const at = (iso: string): string => new Date(iso).toISOString()
    expect(formatConversationTime(at('2026-08-06T11:59:30'), now)).toBe('刚刚')
    expect(formatConversationTime(at('2026-08-06T11:30:00'), now)).toBe('30分钟前')
    expect(formatConversationTime(at('2026-08-06T08:00:00'), now)).toBe('4小时前')
    expect(formatConversationTime(at('2026-08-05T12:00:00'), now)).toBe('昨天')
    expect(formatConversationTime(at('2026-08-04T12:00:00'), now)).toBe('8月4日')
    expect(formatConversationTime(at('2025-08-06T12:00:00'), now)).toBe('2025年8月6日')
    expect(formatConversationTime('not-a-date', now)).toBe('')
  })

  it('migrates the legacy single-thread workspace scope', () => {
    const legacy = migrateLegacyConversation(3)
    expect(legacy).toMatchObject({ id: 'workspace', sessionScope: 'workspace' })
    expect(legacy.title).toBe('原始对话')
    expect(migrateLegacyConversation(0).title).toBe('新的对话')
    expect(isLegacyWorkbenchConversation(legacy)).toBe(true)
    expect(isLegacyWorkbenchConversation({ id: 'ws-new', sessionScope: workbenchSessionScope('ws-new') })).toBe(false)
  })

  it('drops malformed entries when normalizing stored indexes', () => {
    const normalized = normalizeWorkbenchConversations([
      { id: 'ws-ok', title: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionScope: '' },
      { id: '../evil' },
      null,
      'nope'
    ])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ id: 'ws-ok', sessionScope: 'workspace/ws-ok' })
  })
})
