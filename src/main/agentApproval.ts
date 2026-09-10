// Only the native review service failure is retryable; a review denial is not.
export function isAutomaticApprovalFailure(message: string): boolean {
  return /(?:^|\n)\s*(?:Reason:\s*)?Automatic approval review failed:/i.test(message)
}

export class AutomaticApprovalUnavailableError extends Error {
  constructor() {
    super('自动审批服务不可用；当前任务已保留。可稍后继续，或在设置中将 Codex 审批模式切换为 YOLO 后继续任务')
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
