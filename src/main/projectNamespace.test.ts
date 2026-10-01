import { expect, it, vi } from 'vitest'
import { assignDefaultProjectNamespace, hasDefaultProjectNamespace, parseGeneratedProjectNamespace } from './projectNamespace'
import type { ProjectInfo } from '../shared/types'

const project: ProjectInfo = { name: 'Lightning sword', namespace: 'mod_123456abcdef', namespaceSource: 'generated', path: '/projects/sword', loader: 'fabric', minecraftVersion: '', createdAt: '2026-01-01', draft: { target: {} } }

it('replaces generated defaults with a valid English namespace while preserving project identity', async () => {
  const suggest = vi.fn(async () => '{"namespace":"lightning_sword"}')
  const result = await assignDefaultProjectNamespace(project, suggest)
  expect(result).toEqual({ ...project, namespace: 'lightning_sword', namespaceSource: 'ai' })
  expect(project.namespace).toBe('mod_123456abcdef')
  expect(hasDefaultProjectNamespace(result)).toBe(false)
  expect(hasDefaultProjectNamespace({ ...project, draft: undefined, name: '\u95ea\u7535\u5251', namespace: 'mod_ab123' })).toBe(true)
})

it('preserves manual names, readable namespaces and existing non-draft namespaces without provenance', async () => {
  const suggest = vi.fn(async () => '{"namespace":"renamed"}')
  for (const entry of [
    { ...project, namespaceSource: 'manual' as const },
    { ...project, namespace: 'lightning_sword' },
    { ...project, draft: undefined, namespaceSource: undefined },
    { ...project, draft: undefined, namespace: 'mod_tools' }
  ]) expect(await assignDefaultProjectNamespace(entry, suggest)).toBe(entry)
  expect(suggest).not.toHaveBeenCalled()
})

it('rejects malformed output, path fragments and Java keywords, and retains the default when AI fails', async () => {
  for (const value of ['lightning_sword', 'null', '{}', '{"namespace":"../sword"}', '{"namespace":"LightningSword"}', '{"namespace":"class"}', '{"namespace":"mod_1234"}', '{"namespace":"a__b"}', '{"namespace":"' + 'a'.repeat(49) + '"}']) {
    expect(parseGeneratedProjectNamespace(value)).toBeUndefined()
    expect(await assignDefaultProjectNamespace(project, async () => value)).toBe(project)
  }
  expect(await assignDefaultProjectNamespace(project, async () => { throw new Error('offline') })).toBe(project)
})
