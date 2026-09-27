import { ALL_PRESETS, Preset, Sound, Synth, type Parameter } from 'jfxr'

export const studioPitches = ['C5', 'B4', 'A#4', 'A4', 'G#4', 'G4', 'F#4', 'F4', 'E4', 'D#4', 'C#4', 'C4'] as const
export type StudioWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth'
export type EffectPreset = 'pickup' | 'laser' | 'explosion' | 'powerup' | 'hit' | 'jump' | 'blip' | 'random'
export interface StudioLayer { sourceId: string; name: string; offset: number; gain: number; rate: number }
export interface StudioTrack { id: string; name: string; waveform: StudioWaveform; gain: number; notes: number[][] }
export interface StudioDraft {
  version: 2
  mode: 'effect' | 'music'
  eventId: string
  gain: number
  effect: { preset: EffectPreset; settings: string; layers: StudioLayer[] }
  music: { bpm: number; bars: number; tracks: StudioTrack[]; drums: boolean[]; beepboxSong?: string }
}

const presetNames: Record<EffectPreset, string> = {
  pickup: 'Pickup/coin', laser: 'Laser/shoot', explosion: 'Explosion', powerup: 'Powerup',
  hit: 'Hit/hurt', jump: 'Jump', blip: 'Blip/select', random: 'Random'
}
export const effectPresetLabels: Record<EffectPreset, string> = {
  pickup: '拾取', laser: '激光', explosion: '爆炸', powerup: '强化',
  hit: '碰撞', jump: '跳跃', blip: '提示', random: '随机'
}
export function effectSettings(preset: EffectPreset): string {
  const sound = new Sound()
  ALL_PRESETS.find(item => item.name === presetNames[preset])?.applyTo?.(sound)
  return sound.serialize()
}
export function effectParameter(settings: string, key: string): Parameter {
  const sound = new Sound(); sound.parse(settings)
  const value = sound[key]
  if (!value || typeof value !== 'object' || !('value' in value)) throw new Error('音效参数无效：' + key)
  return value as Parameter
}
export function changeEffectParameter(settings: string, key: string, value: number | string | boolean): string {
  const sound = new Sound(); sound.parse(settings)
  const parameter = effectParameter(settings, key)
  if (parameter.values && typeof value === 'string' && !Object.prototype.hasOwnProperty.call(parameter.values, value)) throw new Error('音效参数无效：' + key)
  if (typeof value === 'number' && (!Number.isFinite(value) || parameter.minValue !== null && value < parameter.minValue || parameter.maxValue !== null && value > parameter.maxValue)) throw new Error('音效参数超出范围：' + key)
  ;(sound[key] as Parameter).value = value
  return sound.serialize()
}
export function mutateEffect(settings: string): string {
  const sound = new Sound(); sound.parse(settings); Preset.mutate(sound); return sound.serialize()
}
export function newStudioTrack(index: number): StudioTrack {
  return { id: String(index) + '-' + Date.now(), name: index ? '音轨 ' + (index + 1) : '旋律', waveform: index ? 'triangle' : 'sine', gain: .7, notes: studioPitches.map(() => []) }
}
export function newStudioDraft(): StudioDraft {
  return { version: 2, mode: 'effect', eventId: 'ui/pickup', gain: .75,
    effect: { preset: 'pickup', settings: effectSettings('pickup'), layers: [] },
    music: { bpm: 120, bars: 4, tracks: [newStudioTrack(0)], drums: Array(64).fill(false), beepboxSong: '' } }
}
function finite(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max }
export function parseStudioDraft(value: string): StudioDraft {
  if (value.length > 2 * 1024 * 1024) throw new Error('制作工程超过 2 MiB')
  const raw = JSON.parse(value) as Record<string, unknown>
  if (!raw || typeof raw !== 'object') throw new Error('制作工程格式无效')
  if (raw.version !== 2) {
    const old = raw as { mode?: string; eventId?: string; gain?: number; preset?: string; bpm?: number; waveform?: StudioWaveform; notes?: number[][]; drums?: boolean[] }
    if (!Array.isArray(old.notes) || !Array.isArray(old.drums)) throw new Error('制作工程格式无效')
    const draft = newStudioDraft()
    draft.mode = old.mode === 'music' ? 'music' : 'effect'
    draft.eventId = old.eventId ?? draft.eventId
    draft.gain = old.gain ?? draft.gain
    draft.effect.preset = old.preset === 'impact' ? 'hit' : old.preset === 'signal' ? 'blip' : old.preset === 'laser' ? 'laser' : 'pickup'
    draft.effect.settings = effectSettings(draft.effect.preset)
    draft.music.bpm = old.bpm ?? draft.music.bpm
    draft.music.tracks[0].waveform = old.waveform ?? 'sine'
    draft.music.tracks[0].notes = studioPitches.map((_, row) => Array.from({ length: 4 }, (_, bar) => (old.notes?.[row] ?? []).map(step => bar * 16 + step)).flat())
    draft.music.drums = Array.from({ length: 64 }, (_, step) => Boolean(old.drums?.[step % 16]))
    return parseStudioDraft(JSON.stringify(draft))
  }
  const draft = raw as unknown as StudioDraft
  if (!['effect', 'music'].includes(draft.mode) || typeof draft.eventId !== 'string' || draft.eventId.length > 180 || !finite(draft.gain, .01, 1)) throw new Error('制作工程格式无效')
  if (!draft.effect || !Object.prototype.hasOwnProperty.call(presetNames, draft.effect.preset) || typeof draft.effect.settings !== 'string' || draft.effect.settings.length > 20000 || !Array.isArray(draft.effect.layers) || draft.effect.layers.length > 4) throw new Error('音效工程格式无效')
  const sound = new Sound(); sound.parse(draft.effect.settings)
  for (const layer of draft.effect.layers) if (typeof layer.sourceId !== 'string' || layer.sourceId.length > 400 || typeof layer.name !== 'string' || layer.name.length > 200 || !finite(layer.offset, 0, 30) || !finite(layer.gain, 0, 2) || !finite(layer.rate, .5, 2)) throw new Error('素材层参数无效')
  const music = draft.music
  if (!music || !Number.isInteger(music.bars) || music.bars < 1 || music.bars > 16 || !finite(music.bpm, 40, 240) || !Array.isArray(music.tracks) || music.tracks.length < 1 || music.tracks.length > 8 || !Array.isArray(music.drums) || music.drums.length !== music.bars * 16 || music.drums.some(value => typeof value !== 'boolean')) throw new Error('音乐工程格式无效')
  if (music.beepboxSong !== undefined && (typeof music.beepboxSong !== 'string' || music.beepboxSong.length > 200000)) throw new Error('BeepBox 工程格式无效或过大')
  for (const track of music.tracks) {
    if (typeof track.id !== 'string' || typeof track.name !== 'string' || track.name.length > 48 || !['sine', 'triangle', 'square', 'sawtooth'].includes(track.waveform) || !finite(track.gain, 0, 1) || !Array.isArray(track.notes) || track.notes.length !== studioPitches.length || track.notes.some(row => !Array.isArray(row) || row.length > music.bars * 16 || row.some(step => !Number.isInteger(step) || step < 0 || step >= music.bars * 16))) throw new Error('音乐音轨格式无效')
  }
  return draft
}
export async function renderEffectWav(settings: string): Promise<Uint8Array> {
  const sound = new Sound(); sound.parse(settings)
  if (sound.serialize().length > 20000 || Number((sound.attack as Parameter).value) + Number((sound.sustain as Parameter).value) + Number((sound.decay as Parameter).value) > 12) throw new Error('音效时长超过 12 秒')
  return new Promise((resolve, reject) => {
    const synth = new Synth(sound.serialize())
    const timer = setTimeout(() => { synth.cancel(); reject(new Error('音效合成超时')) }, 15000)
    try { synth.run(clip => { clearTimeout(timer); resolve(clip.toWavBytes()) }) }
    catch (error) { clearTimeout(timer); reject(error) }
  })
}
