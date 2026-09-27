import * as Tone from 'tone'
import { Midi } from '@tonejs/midi'
import { newStudioTrack, parseStudioDraft, renderEffectWav, studioPitches, type StudioDraft } from '../../../shared/soundStudio'

export { effectParameter, effectPresetLabels, effectSettings, changeEffectParameter, mutateEffect, newStudioDraft, newStudioTrack, parseStudioDraft, studioPitches } from '../../../shared/soundStudio'
export type { EffectPreset, StudioDraft, StudioLayer, StudioTrack, StudioWaveform } from '../../../shared/soundStudio'

export function midiToDraft(bytes: ArrayBuffer, previous: StudioDraft): StudioDraft {
  const midi = new Midi(bytes)
  const bpm = Math.max(40, Math.min(240, Math.round(midi.header.tempos[0]?.bpm ?? previous.music.bpm)))
  const stepLength = 60 / bpm / 4
  const lastStep = Math.max(0, ...midi.tracks.flatMap(track => track.notes.map(note => Math.round(note.time / stepLength))))
  const bars = Math.min(16, Math.max(1, Math.ceil((lastStep + 1) / 16)))
  const tracks = midi.tracks.filter(track => track.channel !== 9 && track.notes.length).slice(0, 8).map((track, index) => {
    const result = newStudioTrack(index)
    result.name = track.name.slice(0, 48) || result.name
    for (const note of track.notes) {
      const step = Math.round(note.time / stepLength), row = studioPitches.indexOf(note.name as typeof studioPitches[number])
      if (row >= 0 && step >= 0 && step < bars * 16 && !result.notes[row].includes(step)) result.notes[row].push(step)
    }
    return result
  })
  const drums = Array(bars * 16).fill(false) as boolean[]
  for (const track of midi.tracks.filter(track => track.channel === 9)) for (const note of track.notes) {
    const step = Math.round(note.time / stepLength)
    if (step >= 0 && step < drums.length) drums[step] = true
  }
  return parseStudioDraft(JSON.stringify({ ...previous, mode: 'music', music: { bpm, bars, tracks: tracks.length ? tracks : [newStudioTrack(0)], drums } }))
}

export function draftToMidi(draft: StudioDraft): Uint8Array {
  const valid = parseStudioDraft(JSON.stringify(draft))
  const midi = new Midi()
  midi.header.setTempo(valid.music.bpm)
  const stepLength = 60 / valid.music.bpm / 4
  for (const source of valid.music.tracks) {
    const track = midi.addTrack(); track.name = source.name
    for (let row = 0; row < studioPitches.length; row++) for (const step of source.notes[row]) track.addNote({ name: studioPitches[row], time: step * stepLength, duration: stepLength * 1.5, velocity: source.gain })
  }
  const drum = midi.addTrack(); drum.name = 'Drums'; drum.channel = 9
  valid.music.drums.forEach((active, step) => { if (active) drum.addNote({ midi: 36, time: step * stepLength, duration: stepLength, velocity: .8 }) })
  return midi.toArray()
}

export function encodeWav(audio: AudioBuffer): Uint8Array {
  const channels = Math.min(2, audio.numberOfChannels), frames = audio.length
  const bytes = new Uint8Array(44 + frames * channels * 2), view = new DataView(bytes.buffer)
  const write = (offset: number, value: string): void => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index) }
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * channels * 2, true)
  const values = Array.from({ length: channels }, (_, index) => audio.getChannelData(index))
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const sample = Math.max(-1, Math.min(1, values[channel][frame]))
    view.setInt16(44 + (frame * channels + channel) * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }
  return bytes
}

export async function renderStudio(input: StudioDraft): Promise<Uint8Array> {
  const draft = parseStudioDraft(JSON.stringify(input))
  if (draft.mode === 'effect') {
    if (draft.effect.layers.length) throw new Error('含素材层的音效请通过项目渲染服务试听')
    return renderEffectWav(draft.effect.settings)
  }
  const { bpm, bars, tracks, drums } = draft.music
  const stepLength = 60 / bpm / 4
  const duration = bars * 16 * stepLength + .6
  const buffer = await Tone.Offline(() => {
    const master = new Tone.Gain(draft.gain).toDestination()
    for (const track of tracks) {
      const lead = new Tone.PolySynth(Tone.Synth, { oscillator: { type: track.waveform }, envelope: { attack: .01, decay: .1, sustain: .45, release: .15 } }).connect(new Tone.Gain(track.gain).connect(master))
      for (let row = 0; row < studioPitches.length; row++) for (const step of track.notes[row]) lead.triggerAttackRelease(studioPitches[row], stepLength * 1.5, step * stepLength)
    }
    const drum = new Tone.MembraneSynth({ pitchDecay: .05, octaves: 5, envelope: { attack: .001, decay: .2, sustain: 0 } }).connect(master)
    drums.forEach((active, step) => { if (active) drum.triggerAttackRelease('C2', stepLength, step * stepLength) })
  }, duration, 2, 44100)
  const audio = buffer.get()
  if (!audio) throw new Error('音乐渲染失败')
  return encodeWav(audio)
}
