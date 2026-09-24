import { describe, expect, it, vi } from 'vitest'
import { WorkbenchApprovals } from './workbenchApprovals'
import { codexApprovalRequest, codexApprovalResponse } from './agentApproval'
import { codexApprovalPolicy, normalizeAgentApprovalMode } from '../shared/agentApproval'

const context = { projectPath: 'C:/project', conversationId: 'conversation', runId: 'run' }
const details = { engine: 'codex' as const, kind: 'command' as const, title: '运行命令', detail: 'npm test', allowSession: true }

describe('workbench manual approvals', () => {
  it('keeps YOLO default, enables user approval independently and preserves inspiration isolation', () => {
    expect(normalizeAgentApprovalMode(undefined)).toBe('yolo')
    expect(normalizeAgentApprovalMode('manual')).toBe('manual')
    expect(codexApprovalPolicy(false, 'manual')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: 'modmind-protected' })
    expect(codexApprovalPolicy(true, 'manual')).toEqual(codexApprovalPolicy(true, 'yolo'))
  })

  it('queues concurrent requests, isolates windows and rejects invalid or duplicate answers', async () => {
    const changed = vi.fn()
    const store = new WorkbenchApprovals(changed)
    const signal = new AbortController().signal
    const first = store.request(1, context, details, signal)
    const second = store.request(1, context, { ...details, allowSession: false }, signal)
    const [a, b] = store.list(1)
    expect(store.list(2)).toEqual([])
    expect(store.respond(2, a.id, 'allow')).toBe(false)
    expect(store.respond(1, a.id, 'unknown')).toBe(false)
    expect(store.respond(1, b.id, 'allow-session')).toBe(false)
    expect(store.respond(1, a.id, 'allow-session')).toBe(true)
    expect(store.respond(1, a.id, 'allow')).toBe(false)
    expect(store.respond(1, b.id, 'deny')).toBe(true)
    expect(await first).toBe('allow-session')
    expect(await second).toBe('deny')
    expect(store.list(1)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('cancels on abort or window destruction, without replaying stale requests', async () => {
    const store = new WorkbenchApprovals(() => undefined)
    const controller = new AbortController()
    const pending = store.request(1, context, details, controller.signal)
    const id = store.list(1)[0].id
    controller.abort()
    expect(await pending).toBe('deny')
    expect(store.respond(1, id, 'allow')).toBe(false)
    expect(await store.request(1, context, details, controller.signal)).toBe('deny')
    const next = store.request(1, context, details, new AbortController().signal)
    store.cancelOwner(1)
    expect(await next).toBe('deny')
    expect(store.list(1)).toEqual([])
  })

  it('maps modern, legacy and permission responses without granting unrequested access', () => {
    expect(codexApprovalResponse('item/commandExecution/requestApproval', {}, 'allow-session')).toEqual({ decision: 'acceptForSession' })
    expect(codexApprovalResponse('item/fileChange/requestApproval', {}, 'deny')).toEqual({ decision: 'decline' })
    expect(codexApprovalResponse('execCommandApproval', {}, 'allow')).toEqual({ decision: 'approved' })
    expect(codexApprovalResponse('applyPatchApproval', {}, 'deny')).toHaveProperty('decision.denied')
    const permissions = { network: { enabled: true }, fileSystem: null }
    expect(codexApprovalResponse('item/permissions/requestApproval', { permissions }, 'allow')).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(codexApprovalResponse('item/permissions/requestApproval', { permissions }, 'deny')).toEqual({ permissions: {}, scope: 'turn' })
    expect(codexApprovalRequest('item/commandExecution/requestApproval', { command: 'npm test', availableDecisions: ['accept', 'decline'] })).toMatchObject({ detail: 'npm test', allowSession: false })
    expect(codexApprovalRequest('execCommandApproval', { command: ['npm', 'test'] })).toMatchObject({ detail: 'npm test' })
    expect(codexApprovalRequest('item/fileChange/requestApproval', { changes: [{ path: 'a.ts', diff: '+new' }] })?.detail).toContain('+new')
  })
})
