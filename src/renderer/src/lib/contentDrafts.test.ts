import { expect, it, vi } from 'vitest'
import { contentDraftKey, getContentDraft, saveContentDraft, setContentDraft } from './contentDrafts'

it('keeps drafts isolated by project and file, then clears a successful save', async () => {
  const key = contentDraftKey('project-one', 'config/test.toml')
  setContentDraft(key, { base: 'old', text: 'new' })
  expect(getContentDraft(contentDraftKey('project-two', 'config/test.toml'))).toBeUndefined()
  const write = vi.fn(async () => undefined)
  await saveContentDraft(key, async () => 'old', write)
  expect(write).toHaveBeenCalledWith('new')
  expect(getContentDraft(key)).toBeUndefined()
})

it('retains edits after failed writes or external changes', async () => {
  const key = 'failed-save'
  setContentDraft(key, { base: 'old', text: 'draft' })
  await expect(saveContentDraft(key, async () => 'old', async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
  const write = vi.fn(async () => undefined)
  await expect(saveContentDraft(key, async () => 'external', write)).rejects.toThrow('其他编辑器')
  expect(write).not.toHaveBeenCalled()
  expect(getContentDraft(key)?.text).toBe('draft')
})

it('preserves newer edits during an in-flight save and deduplicates saves', async () => {
  const key = 'pending-save'
  setContentDraft(key, { base: 'old', text: 'first edit' })
  let finish!: () => void
  const write = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const first = saveContentDraft(key, async () => 'old', write)
  const second = saveContentDraft(key, async () => 'old', write)
  await Promise.resolve()
  setContentDraft(key, { base: 'old', text: 'newest edit' })
  finish()
  await Promise.all([first, second])
  expect(write).toHaveBeenCalledTimes(1)
  expect(getContentDraft(key)).toEqual({ base: 'first edit', text: 'newest edit' })
})
