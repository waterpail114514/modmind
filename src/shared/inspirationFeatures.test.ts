import { describe, it, expect } from 'vitest'
import { inspirationFeaturePrompt, normalizeInspirationFeatures, readInspirationFeatures, requiredInspirationFeature } from './inspirationFeatures'
import { buildInspirationHandoff, inspirationKnowledgeContext } from './inspirationKnowledge'
import { parseInspirationEvidenceLink } from './inspirationEvidence'

describe('inspiration selections and handoff', () => {
  it('makes user prohibitions explicit without removing deliberate knowledge-save exceptions', () => {
    const prompt = inspirationFeaturePrompt(normalizeInspirationFeatures({ webResearch: true }))
    expect(prompt).toContain('联网检索：已启用')
    expect(prompt).toContain('图像工坊效果图：用户主动禁止')
    expect(prompt).toContain('[USER_DISABLED_TOOL]')
    expect(prompt).toContain('不限制用户明确要求的知识读取和保存')
    expect(prompt).toContain('已启用工具的连接故障不得归因于用户禁用')
  })
  it('defaults expensive capabilities off and fails closed for malformed saved choices', () => {
    expect(Object.values(readInspirationFeatures(null)).every(value => !value)).toBe(true)
    expect(readInspirationFeatures('{bad')).toEqual(normalizeInspirationFeatures())
    expect(normalizeInspirationFeatures({ jarAnalysis: 'true', deepAnalysis: true })).toMatchObject({ jarAnalysis: false, deepAnalysis: true })
    expect(requiredInspirationFeature('research', { operation: 'compare' })).toBe('comparison')
    expect(requiredInspirationFeature('research', { operation: 'decompile' })).toBe('jarAnalysis')
    expect(readInspirationFeatures(null).imageGeneration).toBe(false)
    expect(readInspirationFeatures('{"imageGeneration":true}').imageGeneration).toBe(true)
    expect(requiredInspirationFeature('image_generate')).toBe('imageGeneration')
    expect(requiredInspirationFeature('image_read_project_asset')).toBeUndefined()
  })
  it('carries user decisions and attachment sources into the workbench without silently dropping long history', () => {
    const result = buildInspirationHandoff('使用事件监听', [
      { role: 'user', content: '必须兼容联机', replay: { attachments: [{ path: '.modmind/attachments/example.jar' }] } },
      { role: 'assistant', content: '使用事件监听' }
    ], [{ id: 'a', title: '设定', content: '冷却 10 秒', updatedAt: '' }])
    for (const text of ['必须兼容联机', '使用事件监听', '.modmind/attachments/example.jar', '冷却 10 秒', '验收条件']) expect(result).toContain(text)
    expect(inspirationKnowledgeContext([])).toBe('')
    expect(buildInspirationHandoff('方案', [{ role: 'user', content: 'a'.repeat(50000) }], [])).toContain('较早讨论已截断')
  })
  it('decodes source citations and rejects invalid line numbers and protocols', () => {
    expect(parseInspirationEvidenceLink('modmind-source:?path=src%2FMain.java&line=42')).toEqual({ path: 'src/Main.java', line: 42 })
    expect(parseInspirationEvidenceLink('modmind-source:?path=mod.jar&file=Main.java&line=2')).toMatchObject({ file: 'Main.java', kind: 'source' })
    expect(() => parseInspirationEvidenceLink('https://example.com/?path=a')).toThrow()
    expect(() => parseInspirationEvidenceLink('modmind-source:?path=a&line=-1')).toThrow()
  })
})
