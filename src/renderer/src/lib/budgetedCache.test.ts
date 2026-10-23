import { expect, it } from 'vitest'
import { BudgetedCache, RebuildableStateCache } from './budgetedCache'

it('bounds retained histories, refreshes recently read entries, and releases removed values', () => {
  const cache = new BudgetedCache<string, string>(12, 3, value => value.length * 2)
  cache.set('first', 'aaa').set('second', 'bbb')
  expect(cache.get('first')).toBe('aaa')
  cache.set('third', 'ccc')
  expect(cache.get('second')).toBeUndefined()
  expect(cache.retainedBytes).toBe(12)
  cache.set('first', 'a')
  cache.set('too-large', 'x'.repeat(20))
  expect(cache.size).toBe(2)
  cache.delete('third')
  expect(cache.retainedBytes).toBe(2)
  cache.clear()
  expect(cache.retainedBytes).toBe(0)
})

it('evicts oversized rebuildable history without dropping a pending draft', () => {
  type State = { draft: string; history: string }
  const cache = new RebuildableStateCache<string, State>(20, 1, value => value.history.length * 2, value => value.draft ? { draft: value.draft, history: '' } : undefined)
  cache.set('project-a', { draft: 'unsaved input', history: 'x'.repeat(100) })
  cache.set('project-b', { draft: '', history: 'ok' })
  expect(cache.get('project-a')).toEqual({ draft: 'unsaved input', history: '' })
  cache.set('project-a', { draft: '', history: 'saved' })
  cache.set('project-c', { draft: '', history: 'next' })
  expect(cache.get('project-a')).toBeUndefined()
})
