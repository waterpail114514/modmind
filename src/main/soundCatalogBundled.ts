import data from './data/soundCatalog.json'
import type { SoundDefinition } from '../shared/soundLibrary'

export function bundledSoundCatalog(version: string): { definitions: Record<string, SoundDefinition>; language: Record<string, string> } | null {
  if (!data.versions.includes(version)) return null
  const names = (data.names as Array<string | [number, string]>).map(value => typeof value === 'string' ? value : data.prefixes[value[0]] + value[1])
  const rows: Record<string, unknown[]> = { ...data.baseline, ...(version === '1.21.1' ? data.changes : {}) }
  if (version === '1.21.1') for (const id of data.removed) delete rows[id]
  const definitions: Record<string, SoundDefinition> = {}, language: Record<string, string> = {}
  for (const [id, row] of Object.entries(rows)) {
    const [subtitleIndex, labelIndex, replace, ...sounds] = row as [number, number, number, ...Array<number | number[]>]
    const subtitle = names[subtitleIndex]
    if (subtitle) language[subtitle] = names[labelIndex]
    definitions[id] = {
      ...(subtitle ? { subtitle } : {}), ...(replace ? { replace: true } : {}),
      sounds: sounds.map(value => typeof value === 'number' ? names[value] : { name: names[value[0]], volume: value[1], pitch: value[2], weight: value[3], stream: Boolean(value[4]), type: value[5] ? 'event' : 'file', attenuation_distance: value[6], preload: Boolean(value[7]) })
    }
  }
  return { definitions, language }
}
