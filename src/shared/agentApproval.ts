export type AgentApprovalMode = 'auto-review' | 'yolo'

export function normalizeAgentApprovalMode(value: unknown): AgentApprovalMode {
  return value === 'yolo' ? 'yolo' : 'auto-review'
}

export function codexApprovalPolicy(readOnly = false, mode?: AgentApprovalMode) {
  if (readOnly) return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' } as const
  if (normalizeAgentApprovalMode(mode) === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' } as const
  }
  return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' } as const
}
