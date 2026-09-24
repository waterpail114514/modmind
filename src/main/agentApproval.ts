import { normalizeAgentApprovalMode, type AgentApprovalMode, type AgentApprovalDecision, type AgentApprovalDetails } from '../shared/agentApproval'

export function codexApprovalRequest(method: string, params: Record<string, unknown>): AgentApprovalDetails | null {
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
  const command = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
  const files = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
  const permissions = method === 'item/permissions/requestApproval'
  if (!command && !files && !permissions) return null
  const value = command ? params.command ?? params.commandActions ?? params.command_actions ?? params
    : files ? params.changes ?? params.fileChanges ?? (params.grantRoot ? { grantRoot: params.grantRoot } : '运行时未提供文件差异，请根据请求原因确认') : params.permissions ?? {}
  return {
    engine: 'codex', kind: command ? 'command' : files ? 'files' : 'permissions',
    title: command ? '允许执行这条命令？' : files ? '允许修改这些文件？' : '允许这次权限请求？',
    detail: Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join(' ') : typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
    allowSession: permissions || legacy || !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('acceptForSession')
  }
}

export function codexApprovalResponse(method: string, params: Record<string, unknown>, decision: AgentApprovalDecision): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') return {
    permissions: decision === 'deny' ? {} : Object.fromEntries(Object.entries((params.permissions ?? {}) as Record<string, unknown>).filter(([key, value]) => ['network', 'fileSystem'].includes(key) && value != null)),
    scope: decision === 'allow-session' ? 'session' : 'turn'
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return {
    decision: decision === 'deny' ? { denied: { rejection: '用户拒绝了本次操作' } } : decision === 'allow-session' ? 'approved_for_session' : 'approved'
  }
  return { decision: decision === 'deny' ? 'decline' : decision === 'allow-session' ? 'acceptForSession' : 'accept' }
}

export function agentApprovalPrompt(mode?: AgentApprovalMode): string {
  const label = normalizeAgentApprovalMode(mode) === 'yolo' ? 'YOLO（默认）' : mode === 'manual' ? '手动审批' : '自动审批'
  return `工作台执行审批：当前为 ${label}。用户可在「设置 → 执行审批 → 工作台审批模式」选择 YOLO、自动审批或手动审批，适用于 Codex 和 Claude Code，仅影响工作台。
手动审批由 ModMind 弹窗收集用户决定；等待审批时不要重复请求同一操作，也不要把未作答当作同意。自动审批服务故障时，宿主会直接回退为本次任务的手动审批，不修改默认设置，不切换 YOLO。
明确的审查拒绝不是服务故障。先说明操作及原因，可尝试最多两种实质不同且允许的低风险方案；仍受阻则停止该操作并保留进度，不得伪装重试或绕过拒绝。审批不能解除只读边界、未开放功能或 ModMind 内部文件保护。`
}

// Only the native review service failure is retryable; a review denial is not.
export function isAutomaticApprovalFailure(message: string): boolean {
  return /(?:^|\n)\s*(?:Reason:\s*)?Automatic approval review failed:/i.test(message)
}

export class AutomaticApprovalUnavailableError extends Error {
  constructor() {
    super('自动审批服务不可用，需要转为手动审批；当前任务进度已保留。')
    this.name = 'AutomaticApprovalUnavailableError'
  }
}

export async function fetchWithApprovalModelFallback(
  url: string, init: RequestInit, body: Record<string, unknown>, fallbackModel?: string
): Promise<Response> {
  const response = await fetch(url, { ...init, body: JSON.stringify(body) })
  if (response.ok || body.model !== 'codex-auto-review' || !fallbackModel || fallbackModel === body.model) return response
  const unavailable = [429, 500, 502, 503, 504].includes(response.status)
    || [400, 403, 404, 422].includes(response.status) && /model[_ -]?(?:not[_ -]found|unavailable|not[_ -]supported)|(?:model|模型)[\s\S]{0,160}(?:not found|not exist|unavailable|not supported|no access|not have access|不存在|不可用|不支持|无权)/i.test(await response.clone().text())
  if (!unavailable || init.signal?.aborted) return response
  await response.body?.cancel()
  console.warn(`[approval] codex-auto-review unavailable (${response.status}); retrying review with ${fallbackModel}`)
  // Keep the review instructions and decision schema intact. Only replace its model.
  return fetch(url, { ...init, body: JSON.stringify({ ...body, model: fallbackModel }) })
}
