import type { SoundEventSave, SoundLibraryItem, SoundProcessOptions } from '../shared/soundLibrary'
import { newStudioDraft, parseStudioDraft, type StudioDraft } from '../shared/soundStudio'
import { digestSound } from './soundFiles'
import type { SoundLibraryService } from './soundLibraryService'

type RenderMusic = (draft: StudioDraft) => Promise<Buffer>
type Dependencies = { service: SoundLibraryService; renderMusic: RenderMusic; assertCurrent: () => void }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('声音工具参数必须是对象')
  return value as Record<string, unknown>
}

export function createSoundMcpHandlers({ service, renderMusic, assertCurrent }: Dependencies): {
  read: (input: Record<string, unknown>) => Promise<unknown>
  create: (input: Record<string, unknown>) => Promise<unknown>
} {
  const draftState = async (): Promise<{ draft: StudioDraft; revision: string }> => {
    const saved = await service.readDraft()
    return { draft: saved ? parseStudioDraft(saved) : newStudioDraft(), revision: saved ? digestSound(saved) : 'none' }
  }
  return {
    read: async input => {
      assertCurrent()
      switch (input.operation) {
        case 'draft': return draftState()
        case 'list': {
          const list = await service.list()
          const view = input.view === 'tracks' ? 'tracks' : 'events'
          const source = typeof input.source === 'string' ? input.source : 'all'
          const kind = typeof input.kind === 'string' ? input.kind : 'all'
          const query = typeof input.query === 'string' ? input.query.trim().toLowerCase().slice(0, 160) : ''
          const offset = Number.isInteger(input.offset) ? Math.max(0, Number(input.offset)) : 0
          const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(100, Number(input.limit))) : 40
          const filtered = (view === 'events' ? list.events : list.items).filter(item => {
            if (source !== 'all' && item.source !== source) return false
            if (kind !== 'all' && !('kind' in item ? item.kind === kind : list.items.some(track => track.eventKey === item.key && track.kind === kind))) return false
            return !query || JSON.stringify(item).toLowerCase().includes(query)
          })
          return { view, total: filtered.length, offset, nextOffset: offset + limit < filtered.length ? offset + limit : null, items: filtered.slice(offset, offset + limit).map(item => view === 'events' ? { ...item, definition: undefined } : item), warnings: list.warnings.slice(0, 10) }
        }
        case 'event': {
          if (typeof input.key !== 'string' || !input.key) throw new Error('请提供事件 key')
          const event = (await service.list()).events.find(item => item.key === input.key || item.namespace + ':' + item.id === input.key)
          if (!event) throw new Error('声音事件不存在或已变化')
          return event
        }
        case 'preview': {
          if (typeof input.id !== 'string' || !input.id) throw new Error('请提供声音条目 id')
          const item = (await service.list()).items.find(value => value.id === input.id) as SoundLibraryItem | undefined
          if (!item) throw new Error('声音条目不存在或已变化')
          if (!item.available) throw new Error('此音频尚未在本机准备，工作台不会自动下载原版资源')
          if (item.size && item.size > 4 * 1024 * 1024) throw new Error('工作台试听上限 4 MiB，请在声音库中试听长音频')
          return { id: item.id, ...(await service.readAudio(item.id)) }
        }
        default: throw new Error('未知的声音读取操作')
      }
    },
    create: async input => {
      assertCurrent()
      switch (input.operation) {
        case 'save-event': {
          const event = record(input.event) as unknown as SoundEventSave
          await service.saveEvent(event)
          assertCurrent()
          const saved = (await service.list(true)).events.find(item => item.editable && item.namespace === event.namespace && item.id === event.id)
          return { saved: true, event: saved ?? null }
        }
        case 'save-draft': {
          if (typeof input.expectedRevision !== 'string') throw new Error('请先读取当前制作工程及修订号')
          const previous = await draftState()
          if (previous.revision !== input.expectedRevision) throw new Error('制作工程已变化，请重新读取后再保存')
          const draft = parseStudioDraft(JSON.stringify(input.draft))
          await service.saveDraft(JSON.stringify(draft))
          return { saved: true, revision: digestSound(JSON.stringify(draft)), draft }
        }
        case 'export': {
          const draft = parseStudioDraft(JSON.stringify(input.draft))
          const bytes = draft.mode === 'music' ? await renderMusic(draft) : await service.renderEffect(draft)
          assertCurrent()
          await service.saveRendered(draft.eventId.trim(), bytes, draft.mode === 'music')
          await service.saveDraft(JSON.stringify(draft))
          const event = (await service.list(true)).events.find(item => item.editable && item.namespace === service.project.namespace && item.id === draft.eventId.trim())
          return { exported: true, eventId: service.project.namespace + ':' + draft.eventId.trim(), eventKey: event?.key ?? null, audioCount: event?.definition.sounds.length ?? 0 }
        }
        case 'process': {
          const options = record(input.process) as unknown as SoundProcessOptions
          await service.process(options)
          return { processed: true, eventId: service.project.namespace + ':' + options.eventId }
        }
        case 'undo': {
          await service.undo()
          return { undone: true }
        }
        default: throw new Error('未知的声音创作操作')
      }
    }
  }
}
