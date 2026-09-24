export type AgentApprovalMode = 'auto-review' | 'manual' | 'yolo'

export type AgentApprovalDecision = 'allow' | 'allow-session' | 'deny'
export interface AgentApprovalDetails {
  engine: 'codex' | 'claude'
  kind: 'command' | 'files' | 'permissions' | 'tool'
  title: string
  detail: string
  reason?: string
  cwd?: string
  allowSession: boolean
  fallbackReason?: string
}
export interface WorkbenchApprovalRequest extends AgentApprovalDetails {
  id: string
  projectPath: string
  conversationId?: string
  runId: string
  createdAt: string
}

export function normalizeAgentApprovalMode(value: unknown): AgentApprovalMode {
  return value === 'auto-review' || value === 'manual' ? value : 'yolo'
}

export function codexApprovalPolicy(readOnly = false, mode?: AgentApprovalMode) {
  if (readOnly) return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' } as const
  if (normalizeAgentApprovalMode(mode) === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' } as const
  }
  if (mode === 'manual') {
    return { approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: 'modmind-protected' } as const
  }
  // Automatic review may review rules, but cannot grant an unsandboxed retry.
  return { approvalPolicy: { granular: { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: false, mcp_elicitations: true } }, approvalsReviewer: 'auto_review', permissions: 'modmind-protected' } as const
}
