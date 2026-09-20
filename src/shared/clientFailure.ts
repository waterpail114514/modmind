import { rawErrorText } from './rawError'

/** Presentation only. Callers must record the original error before using this text. */
export function describeClientFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message
    : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error ?? '')
  const message = raw.replace(/^(?:Error:\s*)?Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:\w*Error:\s*)+/, '').trim()
  if (/已取消|已停止|\babort(?:ed)?\b|\bcancel(?:led|ed)\b/i.test(message)) return '操作已停止。'
  if (/ENOSPC|no space left|磁盘空间不足/i.test(message)) return '磁盘空间不足，请清理后重试。'
  if (/EACCES|EPERM|permission denied|access denied/i.test(message)) return '没有操作权限，请检查文件或目录权限。'
  if (/ENOENT|no such file|file not found/i.test(message)) return '找不到文件，请确认文件仍然存在。'
  if (/EBUSY|resource busy|being used by another process/i.test(message)) return '文件正在使用中，请关闭占用程序后重试。'
  if (/certificate|CERT_|TLS|SSL/i.test(message)) return '安全连接失败，请检查系统时间和网络设置。'
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|连接中断/i.test(message)) return '连接失败，请检查网络后重试。'
  if (/ETIMEDOUT|timeout|timed out|超时/i.test(message)) return '操作超时，请稍后重试。'
  if (/Invalid URL|ERR_INVALID_URL/i.test(message)) return '地址格式不正确，请检查服务地址配置。'
  const status = message.match(/(?:HTTP\s*|status(?:_code)?[\s"':=]*)([45]\d\d)\b/i)?.[1]
  if (status === '401') return '登录已失效，请重新连接账号。'
  if (status === '402') return '余额或额度不足，请检查账号用量。'
  if (status === '403') return '当前账号没有访问权限。'
  if (status === '404') return '找不到所需资源，请检查配置。'
  if (status === '429') return '请求过于频繁，请稍后重试。'
  if (status?.startsWith('5')) return '服务暂时不可用，请稍后重试。'
  if (status || /invalid_request|bad request/i.test(message)) return '请求未被接受，请检查配置或稍后重试。'
  if (/SyntaxError|Unexpected token|not valid JSON|JSON.*(?:position|line)|JSON 解析/i.test(raw)) return '内容格式不正确，请检查后重试。'
  return rawErrorText(error)
}
