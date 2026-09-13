export interface ContentDraft { base: string; text: string }
const drafts = new Map<string, ContentDraft>()
const listeners = new Set<() => void>()
const pendingSaves = new Map<string, Promise<string | undefined>>()
const storageKey = (key: string): string => `modmind:content-draft:${key}`

export const contentDraftKey = (project: string, file: string): string => JSON.stringify([project.replaceAll('\\', '/'), file.replaceAll('\\', '/')])
export const subscribeContentDrafts = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function getContentDraft(key: string): ContentDraft | undefined {
  if (!drafts.has(key)) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(key)) ?? 'null')
      if (saved && typeof saved.base === 'string' && typeof saved.text === 'string') drafts.set(key, saved)
    } catch { /* Memory drafts remain available if browser storage is unavailable. */ }
  }
  return drafts.get(key)
}
export function setContentDraft(key: string, draft: ContentDraft | undefined): void {
  if (draft && draft.text !== draft.base) drafts.set(key, draft)
  else drafts.delete(key)
  try {
    if (drafts.has(key)) sessionStorage.setItem(storageKey(key), JSON.stringify(drafts.get(key)))
    else sessionStorage.removeItem(storageKey(key))
  } catch { /* Do not discard edits when storage is full. */ }
  listeners.forEach(listener => listener())
}

/** A failed save keeps the draft; external edits must never be silently overwritten. */
export async function saveContentDraft(key: string, read: () => Promise<string>, write: (text: string) => Promise<void>): Promise<string | undefined> {
  const pending = pendingSaves.get(key)
  if (pending) return pending
  const snapshot = getContentDraft(key)
  if (!snapshot) return undefined
  const request = (async () => {
    const disk = await read()
    if (disk !== snapshot.base) throw new Error('文件已被其他编辑器修改，草稿已保留。请先复制修改内容，再重新载入文件进行合并。')
    await write(snapshot.text)
    const latest = getContentDraft(key)
    if (latest === snapshot) setContentDraft(key, undefined)
    else setContentDraft(key, { base: snapshot.text, text: latest?.text ?? snapshot.base })
    return snapshot.text
  })()
  pendingSaves.set(key, request)
  try { return await request } finally { pendingSaves.delete(key) }
}
