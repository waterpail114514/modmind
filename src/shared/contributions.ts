export const CONTRIBUTION_TERMS_VERSION = '2026-11-01.1'
export const CONTRIBUTION_CONFIRM_MS = 3_000
export const CONTRIBUTION_TICKET_URL = 'https://mmdesktop.cn-nb1.rains3.com/contributions/upload-ticket.json'
export const CONTRIBUTION_UPLOAD_URL = 'https://cn-nb1.rains3.com/contribute'
export const CONTRIBUTION_MAX_REPORT_BYTES = 64 * 1024
export const CONTRIBUTION_TERMS = [
  '本计划自愿参加，默认关闭。拒绝或关闭不会影响 ModMind 的正常使用。',
  '开启后，仅统计支持的功能调用次数、调用返回状态、耗时区间、应用版本、系统类型及架构；这些调用返回状态不代表异步任务或游戏内容已验证成功。',
  '上传目录使用“登录用户名_10位随机标识哈希”；未登录时使用“guest_10位哈希”。目录包含登录用户名，因此贡献数据并非匿名。用户名切换后，后续统计进入对应目录。',
  '不上传对话、提示词、源码、图片、截图、原始日志、错误正文、项目名、文件路径、密码、API Key、硬件序列号或其他身份资料。网络传输仍会向存储服务暴露来源 IP，本统计文件不记录 IP。',
  '数据通过 HTTPS 上传至 ModMind 维护者管理的雨云私有桶，仅用于改进功能、性能与稳定性。原始贡献统计按 30 天保留目标清理。',
  '断网、上传授权过期或失败时，最多保留 7 天、2 MiB 的本地待传统计，恢复后自动重试。关闭会立即停止新增统计、取消上传并清空本地待传数据，不会自动删除此前已经上传的文件。',
  '可在设置中预览待传内容、查看目录与上传状态。删除已上传贡献可通过官网 ether-studio.top 联系维护者并提供贡献目录；已经上传的请求可能在关闭前完成。'
] as const

export interface ContributionState {
  enabled: boolean
  termsVersion: string
  folder: string
  pendingReports: number
  pendingBytes: number
  phase: 'disabled' | 'idle' | 'uploading' | 'waiting' | 'error'
  message: string
  lastUploadedAt?: string
  ticketExpiresAt?: string
  droppedReports: number
}

export interface ContributionChallenge { token: string; termsVersion: string; waitMs: number; folder: string }
export interface ContributionMetric {
  feature: string
  outcome: 'returned' | 'failed' | 'cancelled'
  duration: '<100ms' | '<1s' | '<10s' | '<60s' | '>=60s'
  count: number
}
export interface ContributionReport {
  format: 'modmind-contribution'
  schemaVersion: 1
  termsVersion: string
  id: string
  day: string
  appVersion: string
  platform: string
  arch: string
  metrics: ContributionMetric[]
}
export interface ContributionPreview { folder: string; reports: ContributionReport[]; truncated: boolean }
export interface ContributionUploadTicket {
  format: 'modmind-contribution-upload'
  schemaVersion: 1
  expiresAt: string
  url: string
  maxBytes: number
  fields: Record<string, string>
}
