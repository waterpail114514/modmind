import type { AgentSettings } from '../../shared/types'

export function verifySettingsSave(patch: Partial<AgentSettings>, saved: AgentSettings): void {
  if (patch.codexApprovalMode === undefined) return
  if (saved.codexApprovalMode === undefined) {
    throw new Error('当前主进程尚未加载审批模式功能。请从系统托盘退出 ModMind 后重新打开，再切换审批模式；刷新页面或关闭到托盘不会生效')
  }
  if (saved.codexApprovalMode !== patch.codexApprovalMode) {
    throw new Error('审批模式未保存成功，请重试；当前仍使用原审批模式')
  }
}
