import { describe, expect, it } from 'vitest'
import { newStudioDraft, parseStudioDraft, renderEffectWav } from '../../../shared/soundStudio'
import { draftToMidi, midiToDraft } from './soundStudioEngine'

describe('sound studio project', () => {
  it('migrates the original repeating 16-step draft without losing notes', () => {
    const old = { mode: 'music', eventId: 'music/theme', gain: .75, preset: 'pickup', bpm: 110, waveform: 'triangle', notes: Array.from({ length: 13 }, (_, row) => row === 0 ? [0, 8] : []), drums: Array.from({ length: 16 }, (_, step) => step === 0) }
    const draft = parseStudioDraft(JSON.stringify(old))
    expect(draft.music.bars).toBe(4)
    expect(draft.music.tracks[0].notes[0]).toEqual([0, 8, 16, 24, 32, 40, 48, 56])
    expect(draft.music.drums.filter(Boolean)).toHaveLength(4)
  })
  it('keeps notes in later bars and separate tracks through MIDI', () => {
    const draft = newStudioDraft()
    draft.music.tracks[0].notes[0] = [0, 35]
    draft.music.drums[48] = true
    const imported = midiToDraft(draftToMidi(draft).buffer as ArrayBuffer, draft)
    expect(imported.music.bars).toBe(4)
    expect(imported.music.tracks[0].notes[0]).toEqual([0, 35])
    expect(imported.music.drums[48]).toBe(true)
  })
  it('renders a jfxr effect and rejects malformed layer settings', async () => {
    const draft = newStudioDraft()
    const wav = await renderEffectWav(draft.effect.settings)
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF')
    draft.effect.layers.push({ sourceId: 'source', name: 'layer', offset: -1, gain: 1, rate: 1 })
    expect(() => parseStudioDraft(JSON.stringify(draft))).toThrow('素材层参数无效')
  })
})
