import type { JavaLoaderKind } from './types'

export interface ServerFixtureJar { path: string; sha256: string; name?: string }
export interface ServerFixtureInput {
  minecraftVersion: string
  loader: JavaLoaderKind
  loaderVersion: string
  jars: ServerFixtureJar[]
}
export interface IsolatedServerStep {
  operation?: 'command' | 'restart'
  command?: string
  expect?: string[]
  timeoutMs?: number
}
export interface ServerFixtureMod { id: string; version: string; file: string; embedded: boolean }
export interface IsolatedServerResult {
  success: boolean
  completed: number
  failedStep?: number
  evidence: string[]
  logPath: string
  reportPath: string
  minecraftVersion: string
  loader: JavaLoaderKind
  loaderVersion: string
  java: { path: string; version: string }
  jars: Array<ServerFixtureJar & { size: number }>
  declaredMods: ServerFixtureMod[]
  observedMods: Array<{ id: string; version: string; evidence: string }>
  warnings: string[]
  cleanup: 'complete' | 'pending' | 'failed'
}
export interface IsolatedServerTask {
  taskId: string
  projectPath: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  phase: 'validating' | 'preparing-java' | 'installing' | 'starting' | 'scenario' | 'stopping' | 'finished'
  message: string
  progress?: number
  completed: number
  total: number
  canCancel: boolean
  logPath?: string
  error?: string
  result?: IsolatedServerResult
  recentLogs: Array<{ time: string; message: string }>
}

export const SERVER_SCENARIO_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    operation: { type: 'string', enum: ['start', 'state', 'cancel', 'files'] },
    taskId: { type: 'string' }, waitSeconds: { type: 'number', minimum: 0, maximum: 20 },
    fixture: { type: 'object', additionalProperties: false, required: ['minecraftVersion', 'loader', 'loaderVersion', 'jars'], properties: {
      minecraftVersion: { type: 'string', minLength: 1, maxLength: 80 },
      loader: { type: 'string', enum: ['fabric', 'quilt', 'forge', 'neoforge'] },
      loaderVersion: { type: 'string', minLength: 1, maxLength: 80 },
      jars: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['path', 'sha256'], properties: { path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, name: { type: 'string' } } } }
    } },
    steps: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
      operation: { type: 'string', enum: ['command', 'restart'] }, command: { type: 'string', maxLength: 1000 },
      expect: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }
    } } },
    timeoutMs: { type: 'integer', minimum: 30000, maximum: 1800000 },
    outputDirectory: { type: 'string' }, port: { type: 'integer', minimum: 1024, maximum: 65535 },
    acceptEula: { type: 'boolean' }, onlineMode: { type: 'boolean' }
  }
} as const
