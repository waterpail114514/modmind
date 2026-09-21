import type { AiNotice } from './types'
import { rawErrorText } from './rawError'

/** Old UI fallback text has no reliable cause; don't invent one during replay. */
export function presentLegacyAiNotice(content: string, advisory = false): string {
  if (!/^操作失败[，,]请重试[；;]仍失败可导出诊断包[。.]?$/.test(content.trim())) return content
  return advisory ? '历史提示未保留原始详情。' : '历史记录未保留原始错误详情。'
}

/** Curated explanations only: never put provider payloads or credentials in the UI. */
export function aiNoticeDetails(kind: 'warning' | 'retry' | 'error', content: string): AiNotice {
  if (kind === 'retry') return {
    key: 'retry', detail: '正在尝试恢复本次任务，无需重复发送。可以等待，也可以停止后调整模型或线路。重试过程已记录在诊断日志中。'
  }
  if (/连续整理上下文/.test(content)) return {
    key: 'context-stall', detail: '最近 5 分钟内连续完成至少 3 次上下文整理，期间没有新的有效工具结果。已暂停自动执行，原会话仍保留；建议切换模型后继续。'
  }
  if (/多次整理上下文/.test(content)) return {
    key: 'compaction', detail: '引擎会整理长对话以腾出空间。这条提醒不代表任务失败或会话被删除；多次整理可能影响细节保留。'
  }
  if (/技能说明已精简/.test(content)) return {
    key: 'skills-budget', detail: '引擎缩短了技能列表中的介绍文字，技能仍可按需读取和使用。无需重新安装技能。'
  }
  if (/目录保护配置未被/.test(content)) return {
    key: 'config-path', detail: '引擎忽略了一个不支持的目录配置项。请更新应用并检查配置；此提醒本身不代表编程任务已经结束。'
  }
  if (/默认能力配置/.test(content)) return {
    key: 'model-metadata', detail: '未找到精确的模型能力信息，当前使用默认配置。实际上下文预算和可用工具可能需要调整。'
  }
  return {
    key: `${kind}:${content}`,
    detail: kind === 'warning' ? '这是引擎提示，不等于本次任务失败。原始通知已记录；如需排查，可通过设置中的诊断功能导出日志。'
      : '本次执行已结束。请按提示处理后再继续；需要协助时，可通过设置中的诊断功能导出日志。'
  }
}

/** Provider warnings are advisory. Empty text keeps an internal notice in diagnostics only. */
export function describeAiNotice(message: string): string {
  if (/Long threads and multiple compactions can cause the model to be less accurate/i.test(message)) {
    return '对话较长，多次整理上下文可能影响回答准确度。'
  }
  if (/Skill descriptions were shortened to fit the skills context budget/i.test(message)) {
    return '技能说明已精简，技能仍可使用。'
  }
  if (/Configured filesystem path .*not recognized.*will be ignored/i.test(message)) {
    return ''
  }
  if (/Model metadata for .*not found.*fallback metadata/i.test(message)) {
    return '当前模型使用默认能力配置，可能影响上下文容量和工具使用。'
  }
  return rawErrorText(message)
}
