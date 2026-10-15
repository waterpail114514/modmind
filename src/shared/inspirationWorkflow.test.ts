import { describe, expect, it } from 'vitest'
import { INSPIRATION_OPEN, INSPIRATION_CLOSE, inspirationPromptHandoff, parseInspirationWorkflow } from './inspirationWorkflow'
import { normalizeInspirationFeatures } from './inspirationFeatures'

const payload = () => ({ version: 1, reply: '整理完成', prompt: { state: 'ready', text: '雷鸣剑\n引号"、反斜杠\\、🗡️，不伤害玩家', blockingQuestionIds: [] }, questions: [], suggestions: [], knowledgeCandidates: [] })
const encode = (value: unknown) => INSPIRATION_OPEN + JSON.stringify(value) + INSPIRATION_CLOSE

describe('inspiration workflow protocol', () => {
  it('previews the open prompt string and never leaks JSON fields at any chunk boundary', () => {
    const value = payload()
    const text = encode(value)
    let sawEarly = false
    for (let i = 1; i <= text.length; i++) {
      const preview = parseInspirationWorkflow(text.slice(0, i))
      expect(preview.protocol).toBe(true)
      if (preview.promptText) {
        expect(value.prompt.text.startsWith(preview.promptText)).toBe(true)
        if (i < text.indexOf('blockingQuestionIds')) sawEarly = true
      }
      expect(preview.complete).toBe(i === text.length)
    }
    expect(sawEarly).toBe(true)
    expect(parseInspirationWorkflow(text).value).toEqual(value)
  })
  it('handles escaped unicode and end tags inside strings without prematurely committing', () => {
    const value = payload()
    value.prompt.text = `${INSPIRATION_CLOSE} { "text": "ordinary" } 🗡`
    const text = encode(value).replace('🗡', '\\ud83d\\udde1')
    for (let i = 1; i <= text.length; i++) {
      const preview = parseInspirationWorkflow(text.slice(0, i))
      expect(preview.complete).toBe(i === text.length)
      if (preview.promptText) expect(value.prompt.text.startsWith(preview.promptText)).toBe(true)
    }
    expect(parseInspirationWorkflow(text).promptText).toBe(value.prompt.text)
  })
  it('rejects duplicate keys, trailing data, malformed terminal JSON and readiness conflicts', () => {
    const text = encode(payload())
    expect(parseInspirationWorkflow(text.replace('"version":1', '"version":1,"version":1')).error).toContain('重复')
    expect(parseInspirationWorkflow(text + 'extra').complete).toBe(false)
    expect(parseInspirationWorkflow(text.replace('"version":1', '"version":2')).complete).toBe(false)
    expect(parseInspirationWorkflow(text.replace('"questions":[]', '"questions":[{"id":"q","text":"范围？","blocking":true,"options":[]}]')).complete).toBe(false)
    expect(parseInspirationWorkflow(INSPIRATION_OPEN + '{"reply":"a"' + INSPIRATION_CLOSE).complete).toBe(false)
  })
  it('retains the visible draft when later metadata is invalid, and never commits it', () => {
    const text = encode(payload()).replace('"knowledgeCandidates":[]', '"knowledgeCandidates":[],"version":1')
    const parsed = parseInspirationWorkflow(text)
    expect(parsed.complete).toBe(false)
    expect(parsed.error).toContain('重复')
    expect(parsed.promptText).toBe(payload().prompt.text)
  })
  it('suppresses forbidden artifacts without upgrading a draft and bounds oversized responses', () => {
    const value = { ...payload(), questions: [{ id: 'q', text: '范围？', blocking: true, options: [] }], suggestions: [{ id: 's', text: '增加音效', reason: '反馈' }] }
    value.prompt.state = 'draft'
    const features = normalizeInspirationFeatures({ autoQuestions: false, suggestions: false, promptOptimization: false, knowledgeOrganization: false })
    const parsed = parseInspirationWorkflow(encode(value), features)
    expect(parsed.value).toMatchObject({ prompt: null, questions: [], suggestions: [], knowledgeCandidates: [] })
    expect(parsed.promptText).toBe('')
    expect(parseInspirationWorkflow(INSPIRATION_OPEN + ' '.repeat(128 * 1024)).error).toContain('过长')
  })
  it('hands off only visible text and deduplicated project attachment references', () => {
    expect(inspirationPromptHandoff('当前提示词', ['a.jar', 'a.jar'])).toBe('当前提示词\n\n参考附件（当前项目相对路径）：\na.jar')
    expect(inspirationPromptHandoff('当前提示词', [])).toBe('当前提示词')
  })
})
