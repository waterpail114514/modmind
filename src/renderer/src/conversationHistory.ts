import type { ConversationDocument, ConversationEventsPage, ConversationHistoryPage, ConversationHistoryPageInput } from '../../shared/types'
import { replayWorkbenchTail, type WorkbenchTimelineItem } from './workbenchTimeline'

type HistoryApi = {
  read: (project: string, id: string) => Promise<ConversationDocument | null>
  readProjection?: (project: string, id: string) => Promise<ConversationDocument | null>
  eventsSince: (project: string, id: string, generation: number, after?: number, limit?: number) => Promise<ConversationEventsPage>
}

export async function readWorkbenchHistoryWindow(api: HistoryApi & { historyPage?: (project: string, id: string, input?: ConversationHistoryPageInput) => Promise<ConversationHistoryPage | null> }, project: string, id: string, input: ConversationHistoryPageInput, cancelled: () => boolean, parse: (value: unknown) => WorkbenchTimelineItem[], normalizeActivity: (value: string) => string, normalizeOutput: (value: string) => string): Promise<{ page: ConversationHistoryPage; timeline: WorkbenchTimelineItem[] } | null> {
  if (!api.historyPage) return null
  const check = (): void => { if (cancelled()) throw new DOMException('History loading cancelled', 'AbortError') }
  const page = await api.historyPage(project, id, input); check()
  if (!page) return null
  if (page.document.id !== id || page.document.surface !== 'workspace') throw new Error('读取到其他对话的历史，请重试')
  let timeline = parse(page.items)
  if ((input.before !== undefined || input.after !== undefined) && page.end < page.total) return { page, timeline }
  let after = Math.max(0, page.document.checkpointSequence)
  while (after < page.document.lastSequence) {
    const batch = await api.eventsSince(project, id, page.document.generation, after, 100); check()
    if (batch.generation !== page.document.generation) throw new Error('对话已更新，请重新载入历史')
    const events = batch.events.filter(event => event.sequence > after && event.sequence <= page.document.lastSequence)
    if (!events.length || events.some(e => e.conversationId !== id || e.generation !== page.document.generation)) throw new Error('对话历史记录未完整读取，请重试')
    timeline = replayWorkbenchTail(timeline, events, normalizeActivity, normalizeOutput)
    after = events.at(-1)!.sequence
    await new Promise<void>(resolve => setTimeout(resolve, 0)); check()
  }
  return { page, timeline }
}

/** Pin a generation/tail while paging. Never treat an I/O failure as missing data. */
export async function readConversationHistory(api: HistoryApi, project: string, id: string, cancelled: () => boolean, progress: (count: number) => void = () => {}): Promise<ConversationDocument | null> {
  const check = (): void => { if (cancelled()) throw new DOMException('History loading cancelled', 'AbortError') }
  check()
  if (!api.readProjection) {
    const document = await api.read(project, id)
    check()
    return document
  }
  const document = await api.readProjection(project, id)
  check()
  if (!document) return null
  if (document.id !== id) throw new Error('读取到其他对话的历史，请重试')
  const events: ConversationDocument['events'] = []
  let after = 0
  while (after < document.lastSequence) {
    const page = await api.eventsSince(project, id, document.generation, after, 5000)
    check()
    if (page.generation !== document.generation) throw new Error('对话已更新，请重新载入历史')
    let next = after
    for (const event of page.events) {
      if (event.generation !== document.generation || event.conversationId !== id) throw new Error('对话历史版本不一致，请重试')
      if (event.sequence <= after) continue
      next = Math.max(next, event.sequence)
      if (event.sequence <= document.lastSequence) events.push(event)
    }
    if (next <= after) {
      throw new Error('对话历史记录未完整读取，请重试')
    }
    after = next
    progress(events.length)
    if (page.nextSequence === null) {
      if (after < document.lastSequence) throw new Error('对话历史记录未完整读取，请重试')
      break
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    check()
  }
  return { ...document, events }
}
