export type AgentApprovalMode = 'auto-review' | 'yolo'

export function normalizeAgentApprovalMode(value: unknown): AgentApprovalMode {
  return value === 'auto-review' ? 'auto-review' : 'yolo'
}

export function codexApprovalPolicy(readOnly = false, mode?: AgentApprovalMode) {
  if (readOnly) return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' } as const
  if (normalizeAgentApprovalMode(mode) === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: 'modmind-protected' } as const
  }
  // Automatic review may review rules, but cannot grant an unsandboxed retry.
  return { approvalPolicy: { granular: { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: false, mcp_elicitations: true } }, approvalsReviewer: 'auto_review', permissions: 'modmind-protected' } as const
}
