import { describe, expect, it } from 'vitest'
import { describeAiFailureForUser } from './aiFailure'

describe('describeAiFailureForUser', () => {
  it('explains an upstream no-output timeout instead of showing a blank inspiration reply', () => {
    const message = describeAiFailureForUser(new Error('Codex 连续 5 分钟没有任何操作。请稍后重试'))
    expect(message).toContain('上游模型')
    expect(message).toContain('没有返回任何内容')
    expect(message).not.toContain('参数')
    expect(describeAiFailureForUser('Codex 已结束，但上游模型没有返回可显示的回答'))
      .toContain('没有返回任何内容')
  })

  it('identifies rate limits as upstream congestion', () => {
    expect(describeAiFailureForUser('last status: 429 Too Many Requests')).toContain('线路繁忙')
    expect(describeAiFailureForUser('模型服务暂时不可用（503）')).toContain('HTTP 503')
    expect(describeAiFailureForUser('模型服务暂时不可用（503）')).not.toContain('429')
  })

  it('does not blame the user for a generic invalid-request relay failure', () => {
    const message = describeAiFailureForUser('请求参数无效，请检查请求格式和参数')
    expect(message).toContain('线路或模型不兼容')
    expect(message).toContain('不是你的需求内容错误')
    expect(message).not.toContain('请修改任务描述')
  })

  it('keeps authentication, quota, model, and connection causes distinct', () => {
    expect(describeAiFailureForUser('401 Unauthorized')).toContain('凭证无效')
    expect(describeAiFailureForUser('402 Payment Required')).toContain('额度不足')
    expect(describeAiFailureForUser('404 Not Found')).toContain('模型接口或所选模型不存在')
    expect(describeAiFailureForUser('stream disconnected before completion')).toContain('连接中断')
    expect(describeAiFailureForUser('rollout not found')).toContain('会话已失效')
    expect(describeAiFailureForUser('no rollout found for thread id 01a08abe-5b20-7490-9a92-5ce3bacdd48f')).toContain('会话记录已丢失')
    expect(describeAiFailureForUser('local file not found')).toBe('local file not found')
    expect(describeAiFailureForUser('permission denied while reading project')).toBe('permission denied while reading project')
  })

  it('explains workflow and unclassified upstream failures without exposing internal labels', () => {
    expect(describeAiFailureForUser('Review Agent rejected completion. Missing stages: validate, build'))
      .toContain('完成检查未通过')
    expect(describeAiFailureForUser('Provider returned error')).toContain('未分类错误')
  })
})
