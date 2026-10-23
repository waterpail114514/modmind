import { describe, expect, it } from 'vitest'
import { freshOnboarding, onboardingGoals, onboardingRequiredFeatures, onboardingTasks, parseOnboarding, pendingOnboardingFeatures, resumeOnboarding } from './onboarding'
import { featureBundles } from './featureInstallPlan'
import type { FeatureStoreEntry } from '../../shared/featureStore'

describe('tutorial recovery', () => {
  it('recovers safely from missing, corrupt and unknown persisted routes', () => {
    for (const raw of [null, '{', '{}', JSON.stringify({ ...freshOnboarding(), phase: 'install' }), JSON.stringify({ ...freshOnboarding(), goal: 'other' }), JSON.stringify({ ...freshOnboarding(), goal: 'mod', task: 'unknown' })]) expect(parseOnboarding(raw)).toEqual(freshOnboarding())
  })
  it('rechecks resources instead of resuming a vanished creation form', () => {
    const saved = { ...freshOnboarding(), phase: 'field' as const, goal: 'mod' as const, task: 'item', fieldIndex: 3 }
    expect(resumeOnboarding(saved)).toMatchObject({ status: 'running', phase: 'features', fieldIndex: 0, projectPath: undefined })
  })
  it('returns to the created project only when it is the current project', () => {
    const saved = { ...freshOnboarding(), phase: 'tool' as const, goal: 'mod' as const, task: 'item', projectPath: 'E:/projects/one' }
    expect(resumeOnboarding(saved, saved.projectPath)).toMatchObject({ phase: 'features', projectPath: saved.projectPath })
    expect(resumeOnboarding(saved, 'E:/projects/two')).toMatchObject({ phase: 'features', projectPath: undefined })
  })
  it('preserves a completed or skipped tutorial and bounds stored form indexes', () => {
    for (const status of ['done', 'skipped'] as const) expect(parseOnboarding(JSON.stringify({ ...freshOnboarding(), status })).status).toBe(status)
    expect(parseOnboarding(JSON.stringify({ ...freshOnboarding(), fieldIndex: -1 })).fieldIndex).toBe(0)
    expect(parseOnboarding(JSON.stringify({ ...freshOnboarding(), fieldIndex: 10000 })).fieldIndex).toBe(32)
  })
  it('has a concrete first task and workspace for each project goal', () => {
    expect(new Set(onboardingGoals.map(goal => goal.id)).size).toBe(4)
    for (const goal of onboardingGoals) {
      expect(onboardingTasks[goal.id].length).toBeGreaterThan(0)
      for (const task of onboardingTasks[goal.id]) expect(task.view).toBeTruthy()
    }
  })
  it('requires the full existing recommendation for every task, including AI-only tasks', () => {
    for (const goal of onboardingGoals) for (const task of onboardingTasks[goal.id]) {
      const required = onboardingRequiredFeatures(goal.id, task.id)
      const bundle = featureBundles.find(bundle => bundle.id === goal.id)!
      expect(required).toEqual([...new Set([goal.featureId, ...bundle.ids, ...(task.featureId ? [task.featureId] : [])])])
    }
    expect(onboardingRequiredFeatures('server', 'command')).toContain('testing')
  })
  it('keeps missing, disabled, unloaded and outdated recommended components pending', () => {
    const ids = onboardingRequiredFeatures('mod', 'idea')
    const entries: FeatureStoreEntry[] = ids.map(id => ({ id, name: id, version: '1', enabled: true, installed: true, available: true, state: 'ready', installHint: '', description: '', groups: [], updateAvailable: false }))
    const modules = Object.fromEntries(ids.map(id => [id, {}]))
    expect(pendingOnboardingFeatures(ids, entries, entries, modules)).toEqual([])
    expect(pendingOnboardingFeatures(ids, entries.filter(entry => entry.id !== 'testing'), entries, modules)).toContain('testing')
    expect(pendingOnboardingFeatures(ids, entries.map(entry => entry.id === 'versions' ? { ...entry, available: false } : entry), entries, modules)).toContain('versions')
    expect(pendingOnboardingFeatures(ids, entries, entries, { ...modules, mappings: undefined })).toContain('mappings')
    expect(pendingOnboardingFeatures(ids, entries.map(entry => entry.id === 'relationships' ? { ...entry, updateAvailable: true } : entry), entries, modules)).toContain('relationships')
    expect(pendingOnboardingFeatures(ids, entries, entries.map(entry => entry.id === 'testing' ? { ...entry, version: 'older' } : entry), modules)).toContain('testing')
  })
})
