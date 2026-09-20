import { describe, expect, it } from 'vitest'
import { describeAiNotice, presentLegacyAiNotice } from './aiNotice'

describe('AI advisory presentation', () => {
  it('preserves the meaning of the three warnings in the user diagnostic archive', () => {
    expect(describeAiNotice('Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.')).toContain('可能影响回答准确度')
    expect(describeAiNotice('Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter.')).toBe('技能说明已精简，技能仍可使用。')
    expect(describeAiNotice('Configured filesystem path `:project_roots/.modmind` is not recognized by this version of Codex and will be ignored. Upgrade Codex if this path is required.')).toContain('目录保护配置未被当前引擎识别')
  })

  it('does not infer a failed task or leak private data from an unknown warning', () => {
    const message = describeAiNotice('Unknown warning: api_key=private https://private.test/token C:\\private\\config.json')
    expect(message).toBe('Unknown warning: api_key=[REDACTED] https://private.test/token C:\\private\\config.json')
    expect(message).not.toContain('api_key=private')
    expect(message).not.toContain('操作失败')
  })

  it('does not invent a cause for old records whose raw details were lost', () => {
    expect(presentLegacyAiNotice('操作失败，请重试；仍失败可导出诊断包。')).toBe('历史记录未保留原始错误详情。')
    expect(presentLegacyAiNotice('server_error')).toBe('server_error')
  })
})
