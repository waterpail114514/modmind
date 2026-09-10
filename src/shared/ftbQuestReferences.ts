import type { FtbQuestBook } from './types'

export function rewriteFtbQuestReferences(book: FtbQuestBook, replacements: ReadonlyMap<string, string | null>): FtbQuestBook {
  const reference = (id: string): string | null => replacements.has(id) ? replacements.get(id)! : id
  return { ...book, chapters: book.chapters.map(chapter => ({ ...chapter,
    raw: { ...chapter.raw, ...(Array.isArray(chapter.raw.quest_links) ? { quest_links: chapter.raw.quest_links.flatMap(value => {
      if (!value || typeof value !== 'object') return [value]
      const link = value as Record<string, unknown>
      const key = typeof link.quest === 'string' ? 'quest' : 'quest_id'
      const target = typeof link[key] === 'string' ? reference(link[key] as string) : undefined
      return target === null ? [] : [{ ...link, ...(target === undefined ? {} : { [key]: target }) }]
    }) } : {}) },
    quests: chapter.quests.map(quest => ({ ...quest, dependencies: [...new Set(quest.dependencies.map(reference).filter((id): id is string => id !== null))] }))
  })) }
}

export function ftbObjectIds(book: FtbQuestBook): Set<string> {
  return new Set(book.chapters.flatMap(chapter => [chapter.id, ...chapter.quests.flatMap(quest => [quest.id, ...quest.tasks.map(task=>task.id), ...quest.rewards.map(reward=>reward.id)])]))
}
