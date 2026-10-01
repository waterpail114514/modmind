import { describe, expect, it } from 'vitest'
import { BackendSwitchCoordinator } from './backendSwitchCoordinator'

describe('backend switch coordinator', () => {
  it('lets the last successfully validated request win even when validation finishes out of order', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const first = coordinator.request('project')
    const second = coordinator.request('project')
    const acceptedSecond = coordinator.accept(second, 'codex', 'quota')
    expect(acceptedSecond).not.toBeNull()
    expect(coordinator.accept(first, 'codex', 'quota')).toBeNull()
  })

  it('does not supersede an accepted switch merely because a later request was rejected before accept', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const first = coordinator.request('project')
    const acceptedFirst = coordinator.accept(first, 'codex', 'quota')!
    coordinator.request('project')
    expect(coordinator.isCurrent(acceptedFirst)).toBe(true)
  })

  it('keeps the original stable rollback value across several pre-ready switches', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const first = coordinator.accept(coordinator.request('project'), 'quota', 'codex')!
    const second = coordinator.accept(coordinator.request('project'), 'codex', 'quota')!
    const third = coordinator.accept(coordinator.request('project'), 'quota', 'codex')!
    expect(first.rollbackValue).toBe('quota')
    expect(second.rollbackValue).toBe('quota')
    expect(third.rollbackValue).toBe('quota')
  })

  it('uses the ready backend as the next stable rollback value', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const first = coordinator.accept(coordinator.request('project'), 'quota', 'codex')!
    expect(coordinator.markReady(first)).toBe(true)
    const second = coordinator.accept(coordinator.request('project'), 'codex', 'quota')!
    expect(second.rollbackValue).toBe('codex')
    expect(coordinator.markReady(first)).toBe(false)
  })

  it('exposes the actual active target after later requests are rejected', () => {
    const coordinator = new BackendSwitchCoordinator<string, { backend: string; switchId: number }>()
    const first = coordinator.accept(coordinator.request('project'), 'quota', { backend: 'codex', switchId: 1 })!
    coordinator.request('project')
    coordinator.request('project')
    expect(coordinator.current('project')).toBe(first)
    expect(coordinator.current('project')?.target).toEqual({ backend: 'codex', switchId: 1 })
  })

  it('clears only the current failed transition', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const first = coordinator.accept(coordinator.request('project'), 'quota', 'codex')!
    const second = coordinator.accept(coordinator.request('project'), 'codex', 'quota')!
    expect(coordinator.fail(first)).toBe(false)
    expect(coordinator.current('project')).toBe(second)
    expect(coordinator.fail(second)).toBe(true)
    expect(coordinator.current('project')).toBeUndefined()
  })

  it('invalidates validation work that has not been accepted yet', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const ticket = coordinator.request('project')
    coordinator.invalidatePending('project')
    expect(coordinator.isLatestRequest(ticket)).toBe(false)
    expect(coordinator.accept(ticket, 'quota', 'codex')).toBeNull()
  })

  it('keeps an accepted transition current while cancellation unwinds it', () => {
    const coordinator = new BackendSwitchCoordinator<string, string>()
    const transition = coordinator.accept(coordinator.request('project'), 'quota', 'codex')!
    coordinator.invalidatePending('project')
    expect(coordinator.isCurrent(transition)).toBe(true)
  })
})
