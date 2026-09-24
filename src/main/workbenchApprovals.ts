import { randomUUID } from 'node:crypto'
import type { AgentApprovalDecision, AgentApprovalDetails, WorkbenchApprovalRequest } from '../shared/agentApproval'

/** Pending requests live only as long as their owning execution, never in saved settings. */
export class WorkbenchApprovals {
  private pending = new Map<string, { owner: number; request: WorkbenchApprovalRequest; finish: (decision: AgentApprovalDecision) => void }>()

  constructor(private readonly changed: (owner: number) => void) {}

  list(owner: number): WorkbenchApprovalRequest[] {
    return [...this.pending.values()].filter(entry => entry.owner === owner).map(entry => entry.request)
  }

  request(owner: number, context: Pick<WorkbenchApprovalRequest, 'projectPath' | 'conversationId' | 'runId'>, details: AgentApprovalDetails, signal: AbortSignal): Promise<AgentApprovalDecision> {
    if (signal.aborted) return Promise.resolve('deny')
    const request = { ...details, ...context, id: randomUUID(), createdAt: new Date().toISOString() }
    return new Promise(resolve => {
      const finish = (decision: AgentApprovalDecision): void => {
        signal.removeEventListener('abort', abort)
        this.pending.delete(request.id)
        resolve(decision)
        this.changed(owner)
      }
      const abort = (): void => finish('deny')
      this.pending.set(request.id, { owner, request, finish })
      signal.addEventListener('abort', abort, { once: true })
      this.changed(owner)
    })
  }

  respond(owner: number, id: string, decision: unknown): boolean {
    const entry = this.pending.get(id)
    if (!entry || entry.owner !== owner) return false
    if (decision !== 'allow' && decision !== 'allow-session' && decision !== 'deny') return false
    if (decision === 'allow-session' && !entry.request.allowSession) return false
    entry.finish(decision)
    return true
  }

  cancelOwner(owner: number): void {
    for (const entry of [...this.pending.values()]) if (entry.owner === owner) entry.finish('deny')
  }
}
