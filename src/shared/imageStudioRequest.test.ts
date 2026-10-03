import { describe, expect, it } from 'vitest'
import { imageGenerationReferences, normalizeImageGenerationRequest, normalizePerfectPixelOptions } from './imageStudioRequest'
import { imageStudioPresets, imageWorkflowPrompt } from './imageStudioPresets'

describe('shared Image Studio parameters', () => {
  it.each(imageStudioPresets)('uses the UI template for $id', preset => {
    const input = { prompt: '红色机器人', presetId: preset.id, ...(preset.requiresReference ? { referenceImage: 'data:image/png;base64,AA==' } : {}) }
    expect(normalizeImageGenerationRequest(input, 'agent').prompt).toBe(imageWorkflowPrompt(input, input.prompt))
    expect(normalizeImageGenerationRequest(input, 'agent').style).toBe('free')
  })

  it.each([
    { count: 1.5 }, { count: 11 }, { size: 'bad' }, { quality: 'ultra' }, { moderation: 'off' },
    { removeBackground: 'false' }, { backgroundColor: 'white' }, { presetId: 'unknown' },
    { presetId: 'material-variant' }, { referenceImage: '/some/path.png' }, { presetPrompt: 'missing id' },
    { referenceImages: 'data:image/png;base64,AA==' }, { referenceImages: [] }, { referenceImages: [''] },
    { referenceImages: ['data:image/png;base64,AA==', '/some/path.png'] }, { referenceImages: [null] }
  ])('rejects invalid parameters instead of silently dropping them: %j', patch => {
    expect(() => normalizeImageGenerationRequest({ prompt: 'cat', ...patch }, 'agent')).toThrow()
  })

  it('preserves all references in order, including the legacy single field, without changing count', () => {
    const references = ['data:image/png;base64,AQ==', 'data:image/jpeg;base64,Ag==']
    const input = { prompt: 'cat', presetId: 'material-variant', referenceImage: 'data:image/png;base64,AA==', referenceImages: references, count: 2 }
    const request = normalizeImageGenerationRequest(input, 'agent')
    expect(imageGenerationReferences(request)).toEqual([input.referenceImage, ...references])
    expect(request.count).toBe(2)
    const again = normalizeImageGenerationRequest(request, 'agent')
    expect(imageGenerationReferences(again)).toEqual(imageGenerationReferences(request))
    expect(normalizeImageGenerationRequest({ ...input, referenceImage: undefined }, 'manual').referenceImages).toEqual(references)
  })

  it('rejects an oversized reference before service execution', () => {
    const reference = `data:image/png;base64,${'A'.repeat(Math.ceil((20 * 1024 * 1024 + 1) / 3) * 4)}`
    expect(() => normalizeImageGenerationRequest({ prompt: 'cat', referenceImages: [reference] }, 'manual')).toThrow('20 MB')
  })

  it('keeps edited presets and source under host control', () => {
    const input = { presetId: 'creature-views', presetPrompt: '修改后的模板', prompt: '红色', source: 'manual', apiKey: 'untrusted-key', baseUrl: 'https://untrusted.test' }
    const request = normalizeImageGenerationRequest(input, 'agent')
    expect(request).toMatchObject({ source: 'agent', prompt: imageWorkflowPrompt(input, '红色') })
    expect(request).not.toHaveProperty('apiKey')
    expect(request).not.toHaveProperty('baseUrl')
  })

  it('validates every PerfectPixel control and preserves explicit zero/false', () => {
    const options = { sampleMethod: 'median' as const, gridSize: [32, 16] as [number, number], minSize: 0.1, peakWidth: 9, refineIntensity: 0, fixSquare: false }
    expect(normalizePerfectPixelOptions(options)).toEqual(options)
    for (const invalid of [{ gridSize: [0, 1] }, { sampleMethod: 'unknown' }, { refineIntensity: 2 }, { fixSquare: 'false' }]) {
      expect(() => normalizePerfectPixelOptions(invalid)).toThrow()
    }
  })
})
