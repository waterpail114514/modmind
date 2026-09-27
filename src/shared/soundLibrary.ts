export type SoundLibrarySource = 'project' | 'vanilla' | 'pack' | 'mod' | 'library'
export type SoundLibraryKind = 'effect' | 'music' | 'unknown'
export interface SoundVariant { name: string; type?: 'file' | 'event'; volume?: number; pitch?: number; weight?: number; stream?: boolean; attenuation_distance?: number; preload?: boolean; [key: string]: unknown }
export interface SoundDefinition { sounds: Array<string | SoundVariant>; subtitle?: string; replace?: boolean; [key: string]: unknown }
export interface SoundEvent { key: string; id: string; namespace: string; sourceId: string; source: SoundLibrarySource; sourceLabel: string; subtitle: string; definition: SoundDefinition; revision: string; editable: boolean }
export interface SoundSource { id: string; name: string; kind: SoundLibrarySource; error?: string }

export interface SoundLibraryItem {
  id: string
  eventId: string
  name: string
  source: SoundLibrarySource
  kind: SoundLibraryKind
  path: string
  subtitle?: string
  available: boolean
  stream: boolean
  volume?: number
  pitch?: number
  weight?: number
  sourceId?: string
  sourceLabel?: string
  eventKey?: string
  size?: number
}

export interface SoundLibraryResult {
  items: SoundLibraryItem[]
  sourceStatus: { project: string; vanilla: string }
  events: SoundEvent[]
  sources: SoundSource[]
  warnings: string[]
}

export interface SoundLibraryAudio {
  dataUrl: string
  name: string
}

export interface SoundEventSave { key?: string; id: string; namespace: string; definition: SoundDefinition; revision?: string; remove?: boolean }
export interface SoundImportOptions { eventId?: string; group: boolean; stream: boolean }
export interface SoundImportResult { imported: number; errors: string[] }
export interface SoundProcessOptions { id: string; eventId: string; start: number; end?: number; fadeIn: number; fadeOut: number; gain: number; mono: boolean; reverse: boolean }
export interface SoundLibraryApi {
  list: (projectPath: string, refresh?: boolean) => Promise<SoundLibraryResult>
  preview: (projectPath: string, id: string, download?: boolean) => Promise<SoundLibraryAudio>
  saveEvent: (projectPath: string, input: SoundEventSave) => Promise<void>
  import: (projectPath: string, input: SoundImportOptions) => Promise<SoundImportResult | null>
  addFolder: (projectPath: string, minecraft?: boolean) => Promise<boolean>
  removeFolder: (projectPath: string, id: string) => Promise<void>
  fetchVanilla: (projectPath: string) => Promise<void>
  cancel: (projectPath: string) => Promise<void>
  process: (projectPath: string, input: SoundProcessOptions) => Promise<void>
  saveRendered: (projectPath: string, eventId: string, wav: Uint8Array, stream: boolean) => Promise<void>
  renderEffect: (projectPath: string, draft: import('./soundStudio').StudioDraft) => Promise<SoundLibraryAudio>
  onRenderRequest: (listener: (request: { id: string; draft: import('./soundStudio').StudioDraft }) => void) => () => void
  completeRender: (id: string, bytes?: Uint8Array, error?: string) => void
  readDraft: (projectPath: string) => Promise<string | null>
  saveDraft: (projectPath: string, value: string) => Promise<void>
  exportMidi: (projectPath: string, bytes: Uint8Array) => Promise<string | null>
  undo: (projectPath: string) => Promise<void>
  clearCache: (projectPath: string) => Promise<void>
}
