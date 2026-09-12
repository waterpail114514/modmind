import type { LoaderKind } from './types'

export type MinecraftRuntimeStage =
  | 'idle'
  | 'preparing'
  | 'downloading-java'
  | 'downloading-game'
  | 'installing-loader'
  | 'installing-fabric'
  | 'building-mod'
  | 'testing-server'
  | 'headless-testing'
  | 'syncing-mod'
  | 'launching'
  | 'running'
  | 'stopped'
  | 'error'

export interface MinecraftRuntimeEvent {
  stage: MinecraftRuntimeStage
  message: string
  time: string
  progress?: number
  total?: number
  level?: 'info' | 'warning' | 'error'
  projectPath?: string
}

export function appendMinecraftRuntimeEvent(
  events: MinecraftRuntimeEvent[],
  event: MinecraftRuntimeEvent,
  limit: number
): MinecraftRuntimeEvent[] {
  const last = events.at(-1)
  if (
    event.progress !== undefined
    && last?.progress !== undefined
    && last.stage === event.stage
    && last.message === event.message
  ) {
    return [...events.slice(0, -1), event].slice(-limit)
  }
  return [...events, event].slice(-limit)
}

export interface MinecraftManagedMod {
  name: string
  path: string
  size: number
  modifiedAt: string
  projectArtifact: boolean
}

export interface MinecraftCrashInfo {
  summary: string
  reportPath?: string
  exitCode: number | null
  time: string
}

export interface MinecraftRuntimeState {
  projectPath?: string
  stage: MinecraftRuntimeStage
  minecraftVersion: string
  loader?: LoaderKind
  loaderVersionId?: string
  fabricVersionId?: string
  loaderVersion?: string
  javaPath?: string
  instancePath?: string
  installed: boolean
  running: boolean
  pid?: number
  message: string
  mods: MinecraftManagedMod[]
  lastCrash?: MinecraftCrashInfo
}

export type LocalServerStage = 'idle' | 'preparing' | 'building' | 'installing' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface LocalServerEvent {
  stage: LocalServerStage
  message: string
  time: string
  level?: 'info' | 'warning' | 'error'
}

export interface LocalServerLogEntry {
  message: string
  time: string
  level?: 'info' | 'warning' | 'error'
}

export interface LocalServerOperationProgress {
  message: string
  fraction?: number
  downloaded?: number
  total?: number
}

export interface LocalServerState {
  projectPath?: string
  sessionId?: string
  canCancel?: boolean
  stage: LocalServerStage
  minecraftVersion: string
  loader?: LoaderKind
  loaderVersion?: string
  running: boolean
  address?: string
  port?: number
  pid?: number
  logPath?: string
  recentLogs: LocalServerLogEntry[]
  operationProgress?: LocalServerOperationProgress
  message: string
}

export interface MinecraftLaunchOptions {
  username: string
  maxMemoryMb: number
  width?: number
  height?: number
}

export interface MinecraftLaunchTestResult {
  success: boolean
  state: MinecraftRuntimeState
  crash?: MinecraftCrashInfo
}

export interface HeadlessSmokeTestResult {
  success: boolean
  launcherVersion: string
  launcherPath: string
  transcriptPath: string
  stableWindowMs: number
  message: string
  joinedServer?: boolean
  serverAddress?: string
}

export interface GradleVerificationResult {
  task?: string
  skipped: boolean
  success: boolean
  summary: string
  logPath?: string
}

export interface MinecraftApi {
  getState: () => Promise<MinecraftRuntimeState>
  prepare: () => Promise<MinecraftRuntimeState>
  cancelPreparation: () => Promise<MinecraftRuntimeState>
  restartPreparation: () => Promise<MinecraftRuntimeState>
  buildProject: (projectPath?: string) => Promise<MinecraftManagedMod>
  launch: (options: MinecraftLaunchOptions) => Promise<MinecraftRuntimeState>
  testLaunch: (options: MinecraftLaunchOptions) => Promise<MinecraftLaunchTestResult>
  headlessSmokeTest: () => Promise<HeadlessSmokeTestResult>
  openHeadlessMcLogin: () => Promise<void>
  stop: () => Promise<MinecraftRuntimeState>
  syncProjectMod: () => Promise<MinecraftManagedMod | null>
  syncModpack: () => Promise<MinecraftRuntimeState>
  importMods: () => Promise<MinecraftManagedMod[]>
  removeMod: (name: string) => Promise<MinecraftManagedMod[]>
  listMods: () => Promise<MinecraftManagedMod[]>
  onState: (listener: (state: MinecraftRuntimeState) => void) => () => void
  onEvent: (listener: (event: MinecraftRuntimeEvent) => void) => () => void
}
