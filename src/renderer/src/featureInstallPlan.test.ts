import { describe, expect, it } from 'vitest'
import type { FeatureStoreEntry } from '../../shared/featureStore'
import { featureInstallPlan } from './featureInstallPlan'

const entry = (id: string, size: number, dependencies: string[] = []): FeatureStoreEntry => ({
  id, name: id, version: '1.0.0', description: '', groups: [], enabled: false, installed: false,
  available: false, state: 'not-installed', installHint: '', updateAvailable: false,
  release: { id, name: id, description: '', version: '1.0.0', apiVersion: 2, hostVersion: '1.5.0-plugintest', path: '', sha256: '', size, publishedAt: '', changelog: [], dependencies, groups: [] }
})

describe('feature installation download estimate', () => {
  it('counts shared and transitive downloads only once', () => {
    const entries = [entry('a', 10, ['shared']), entry('b', 20, ['shared']), entry('shared', 30, ['data']), entry('data', 40)]
    const plan = featureInstallPlan(entries, ['a', 'b'])
    expect(plan.bytes).toBe(100)
    expect(plan.dependencies.map(item => item.id)).toEqual(['data', 'shared'])
    expect(plan.error).toBeUndefined()
  })

  it('skips ready dependencies but counts an explicitly selected update', () => {
    const ready = { ...entry('shared', 30), available: true, installed: true, enabled: true, updateAvailable: true }
    const entries = [entry('a', 10, ['shared']), ready]
    expect(featureInstallPlan(entries, ['a']).bytes).toBe(10)
    expect(featureInstallPlan(entries, ['a', 'shared']).bytes).toBe(40)
  })

  it('reports unavailable and cyclic dependencies instead of a valid estimate', () => {
    expect(featureInstallPlan([entry('a', 10, ['missing'])], ['a']).error).toContain('missing')
    expect(featureInstallPlan([entry('a', 10, ['b']), entry('b', 20, ['a'])], ['a']).error).toContain('循环')
  })
})
