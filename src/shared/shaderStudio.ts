export interface ShaderFile { path: string; size: number; kind: 'shader' | 'image' | 'config' | 'text' | 'binary' }
export interface ShaderOption { name: string; value: string; values: string[]; files: Array<{ path: string; line: number }>; title: string; slider?: boolean; declaration?: 'define' | 'toggle' | 'const' }
export interface ShaderProgram { name: string; stages: string[] }
export interface ShaderOptionGroup { name: string; title: string; options: string[] }
export interface ShaderInventory {
  revision: string; files: ShaderFile[]; programs: ShaderProgram[]; options: ShaderOption[]; profiles: Record<string, Record<string, string>>
  profilePrograms: Record<string, Record<string, boolean>>
  profileIssues: Record<string, string[]>
  optionGroups: ShaderOptionGroup[]
  optionIssues: ShaderIssue[]
  programConditions: Record<string, string>
  configurationConditional: boolean
}
export interface ShaderDocument { path: string; content: string; revision: string }
export interface ShaderIssue { severity: 'error' | 'warning'; path: string; line?: number; message: string }
export interface ShaderValidation { status: 'syntax-checked' | 'structure-checked' | 'failed'; revision: string; issues: ShaderIssue[]; parsed: number; skipped: number; gameVerified: false }
export interface ShaderTestState {
  warnings?: string[]
  instancePath?: string
  irisDetected: boolean
  deployed?: { path: string; revision: string; sha256: string; deployedAt: string; logOffset?: number }
  log?: { text: string; issues: string[]; modifiedAt: string; fresh: boolean; packMentioned: boolean }
  screenshots: Array<{ name: string; dataUrl: string }>
}

export interface ShaderRuntimeCapabilities {
  supported: boolean
  ready: boolean
  minecraft: string
  iris?: { version: string; path: string; sha256: string }
  runtimeRoot?: string
  versions: Array<{ id: string; minecraft: string }>
  java?: { home: string; major: number }
  issues: string[]
  backend: 'iris-session-agent'
  runtimeVerified: false
}
export interface ShaderRuntimeObservation {
  packName: string | null
  pipeline: string | null
  pipelineError: string | null
  shaderPackLoaded: boolean
  effectiveOptions: Record<string, string>
  profile: string | null
  gameReady: boolean
  observedAt: string
}
export interface ShaderRuntimeSession {
  sessionId: string
  taskId: string
  status: 'preparing' | 'launching' | 'ready' | 'stopping' | 'stopped' | 'failed'
  message: string
  directory: string
  versionId: string
  pid?: number
  running: boolean
  createdAt: string
  expiresAt: string
  artifact?: { revision: string; sha256: string; name: string }
  observation?: ShaderRuntimeObservation
  shutdown?: 'graceful' | 'forced' | 'not-started' | 'exited'
  logTail: string
  gameVerified: false
}
