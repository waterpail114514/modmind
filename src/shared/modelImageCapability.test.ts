import { describe, expect, it } from 'vitest'
import { modelImageCapabilityLabel, parseModelImageCapability } from './modelImageCapability'

describe('explicit image input metadata', () => {
  it.each([
    [{ input_modalities: ['text', 'image'] }, 'supported'],
    [{ architecture: { input_modalities: ['image', 'text'] } }, 'supported'],
    [{ modalities: { input: ['text', 'image'], output: ['text'] } }, 'supported'],
    [{ supports_image_input: false }, 'unsupported'],
    [{ supports_vision: true }, 'supported'],
    [{ capabilities: { vision: false } }, 'unsupported'],
    [{ capabilities: ['vision', 'tools'] }, 'supported'],
    [{ input_modalities: ['text'] }, 'unsupported']
  ])('reads supplier declarations %j', (entry, status) => {
    expect(parseModelImageCapability(entry)).toEqual({ status, source: 'provider' })
  })
  it.each([{ id: 'gpt-6-sol' }, { id: 'claude-opus-5-5' }, { id: 'private' }, { capabilities: ['tools'] },
    { modalities: ['text', 'image'] }, { input_modalities: [] }, { input_modalities: ['text', null] },
    { supports_vision: 'true' }, { supports_image_detail_original: false }])('does not guess missing input metadata %j', entry => {
    expect(parseModelImageCapability(entry)).toBeUndefined()
  })
  it('distinguishes supplier declarations, real requests, and unknown in labels', () => {
    expect(modelImageCapabilityLabel()).toBe('图像能力未知')
    expect(modelImageCapabilityLabel({ status: 'supported', source: 'provider' })).toBe('上游声明支持图像')
    expect(modelImageCapabilityLabel({ status: 'supported', source: 'request' })).toBe('上游已接受图像')
    expect(modelImageCapabilityLabel({ status: 'supported', source: 'probe' })).toBe('识图已验证')
    expect(modelImageCapabilityLabel({ status: 'unsupported', source: 'request' })).toBe('图像输入已被上游拒绝')
  })
})
