import { expect, it } from 'vitest'
import { normalizeInspirationFeatures } from './inspirationFeatures'
import { INSPIRATION_SUBMISSION_SCHEMA, normalizeInspirationSubmission } from './inspirationSubmission'

const features = normalizeInspirationFeatures()
const note = { title: '赐福', content: '特殊赐福强于普通卦效', sourceQuote: '特殊赐福强于普通卦效' }
it('accepts a complete fourteen-note submission without a per-batch count limit', () => {
  const knowledge = Array.from({ length: 14 }, (_, index) => ({ ...note, title: `赐福 ${index + 1}` }))
  expect(INSPIRATION_SUBMISSION_SCHEMA.properties.knowledge).not.toHaveProperty('maxItems')
  const result = normalizeInspirationSubmission({ knowledge, prompt: { state: 'ready', text: '完整制作' } }, 'current:user', note.sourceQuote, features)
  expect(result.knowledgeCandidates).toHaveLength(14)
  expect(result.prompt?.text).toBe('完整制作')
})
it('binds provenance on the host and derives optional interaction IDs', () => {
  const value = normalizeInspirationSubmission({ knowledge: [note], prompt: { state: 'draft', text: '制作赐福' },
    questions: [{ text: '持续多久？', blocking: true, options: [{ label: '10秒' }] }], suggestions: [{ text: '先做单人版' }] },
  'current:user', note.sourceQuote, features)
  expect(value.knowledgeCandidates[0]).toMatchObject({ sourceMessageIds: ['current:user'], scope: 'project' })
  expect(value.questions[0]).toMatchObject({ id: 'q1', options: [{ id: 'o1', label: '10秒' }] })
  expect(value.prompt?.blockingQuestionIds).toEqual(['q1'])
})
it('rejects caller-selected identities and identifies the invalid source quote', () => {
  expect(() => normalizeInspirationSubmission({ projectPath: '../other', knowledge: [note] }, 'current:user', note.sourceQuote, features)).toThrow('input.projectPath')
  expect(() => normalizeInspirationSubmission({ knowledge: [{ ...note, sourceMessageIds: ['old:user'] }] }, 'current:user', note.sourceQuote, features)).toThrow('sourceMessageIds')
  expect(() => normalizeInspirationSubmission({ knowledge: [note] }, 'current:user', '上一轮没有授权', features)).toThrow('knowledge[0].sourceQuote')
})
it.each([
  ['promptOptimization', { prompt: { state: 'ready', text: '制作赐福' } }],
  ['knowledgeOrganization', { knowledge: [note] }],
  ['autoQuestions', { questions: [{ text: '范围？', blocking: true }] }],
  ['suggestions', { suggestions: [{ text: '扩充玩法' }] }]
])('enforces %s independently of discovery', (key, input) => {
  expect(() => normalizeInspirationSubmission(input, 'current:user', note.sourceQuote,
    normalizeInspirationFeatures({ [key as string]: false }))).toThrow('USER_DISABLED_TOOL')
})
it('still rejects readiness conflicts and malformed or oversized content', () => {
  expect(() => normalizeInspirationSubmission({ prompt: { state: 'ready', text: '执行' }, questions: [{ text: '范围？', blocking: true }] }, 'current:user', '', features)).toThrow('待确认')
  expect(() => normalizeInspirationSubmission({ knowledge: [{ ...note, content: 'x'.repeat(20001) }] }, 'current:user', note.sourceQuote, features)).toThrow('候选无效')
  expect(() => normalizeInspirationSubmission({ prompt: { state: ['ready'], text: '执行' } }, 'current:user', '', features)).toThrow('提示词格式无效')
  expect(() => normalizeInspirationSubmission({ prompt: { state: 'ready', text: '执行', blockingQuestionIds: null } }, 'current:user', '', features)).toThrow('提示词格式无效')
  expect(() => normalizeInspirationSubmission({ knowledge: [{ ...note, scope: ['project'] }] }, 'current:user', note.sourceQuote, features)).toThrow('候选无效')
  expect(() => normalizeInspirationSubmission({ knowledge: [note, { ...note, content: 'x'.repeat(132000) }] }, 'current:user', note.sourceQuote, features)).toThrow('过长')
})
