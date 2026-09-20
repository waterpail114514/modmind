import { redactDiagnosticText } from './redactDiagnosticText'

/** Preserve an unknown provider's explanation instead of guessing its cause. */
export function rawErrorText(error: unknown): string {
  let raw: string
  if (error instanceof Error) raw = error.message
  else if (typeof error === 'string') raw = error
  else if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') raw = record.message
    else {
      try { raw = JSON.stringify(error) } catch { raw = String(error) }
    }
  } else raw = String(error ?? '')
  const message = raw.replace(/^(?:Error:\s*)?Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/, '').trim()
  if (/^操作失败[，,]请重试[；;]仍失败可导出诊断包[。.]?$/.test(message)) return '历史记录未保留原始错误详情。'
  return redactDiagnosticText(message) || '未提供错误详情。'
}
