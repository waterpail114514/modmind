import { normalizeAgentApprovalMode, type AgentApprovalMode } from '../shared/agentApproval'

export function agentApprovalPrompt(mode?: AgentApprovalMode): string {
  return `执行审批设置：当前为 ${normalizeAgentApprovalMode(mode) === 'yolo' ? 'YOLO（默认，免审批）' : '自动审批'}。用户可以在「设置 → 执行审批 → Codex 审批模式」单独调整，和对话框的制作功能勾选是两处独立设置；Claude Code 的原生权限不由这个 Codex 设置控制。
遇到明确的审查拒绝时，先说明被拒绝的操作及原因；不要把拒绝误报成审批服务不可用。可以根据反馈尝试最多两种实质不同、风险更低且仍符合用户目标的方案，例如缩小修改范围或使用允许的托管操作。不能反复重试同一操作、改写命令伪装相同效果或绕过保护。没有合规替代方案时立即停止该受阻操作；尝试后仍被拒绝时停止并保留进度，说明已尝试方案和剩余工作。若确实由 Codex 自动审批阻塞，告知用户上述设置位置，由用户调整后重新发送指令，禁止替用户修改审批模式或把普通“继续”理解为设置已修改。
Automatic approval review failed 表示审批服务故障，允许有限重连；持续故障应停下，请用户稍后重试，或自行调整上述设置后重新发送指令。只读限制、未勾选功能、ModMind 内部文件保护和确定的安全拒绝不是同一种问题，YOLO 不会解除这些限制，不能建议切换 YOLO 来突破它们。`
}

// Only the native review service failure is retryable; a review denial is not.
export function isAutomaticApprovalFailure(message: string): boolean {
  return /(?:^|\n)\s*(?:Reason:\s*)?Automatic approval review failed:/i.test(message)
}

export class AutomaticApprovalUnavailableError extends Error {
  constructor() {
    super('自动审批服务不可用；当前任务已保留。可稍后重试，或在「设置 → 执行审批 → Codex 审批模式」自行调整后重新发送指令。YOLO 不会解除内部文件保护、只读限制或未勾选功能的限制。')
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
