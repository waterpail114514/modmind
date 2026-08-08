import { contextBridge, ipcRenderer } from 'electron'
import type { AiOutputEvent, AiSettings, BuildTrustRequest, ExistingProjectAdoptInput, InspirationChatMessage, ModMindApi, PipelineEvent, ProjectCreateInput, ProjectMigrationInput } from '../shared/types'
import type { BlockbenchAction, BlockbenchBounds } from '../shared/blockbench'
import type { MinecraftLaunchOptions, MinecraftRuntimeEvent, MinecraftRuntimeState } from '../shared/minecraft'
import type { AudioImportInput, ContentCreateInput, DependencyInstallInput, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, TestTarget } from '../shared/production'

const api: ModMindApi = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  project: {
    listLoaderVersions: (refresh?: boolean) => ipcRenderer.invoke('project:listLoaderVersions', refresh),
    create: (input: ProjectCreateInput) => ipcRenderer.invoke('project:create', input),
    open: () => ipcRenderer.invoke('project:open'),
    openRecent: (projectPath: string) => ipcRenderer.invoke('project:openRecent', projectPath),
    listRecent: () => ipcRenderer.invoke('project:listRecent'),
    removeRecent: (projectPath: string) => ipcRenderer.invoke('project:removeRecent', projectPath),
    inspectExisting: (sourceType?: 'folder' | 'zip') => ipcRenderer.invoke('project:inspectExisting', sourceType),
    adoptExisting: (input: ExistingProjectAdoptInput) => ipcRenderer.invoke('project:adoptExisting', input),
    current: () => ipcRenderer.invoke('project:current'),
    listFiles: () => ipcRenderer.invoke('project:listFiles'),
    readFile: (relativePath: string) => ipcRenderer.invoke('project:readFile', relativePath),
    writeFile: (relativePath: string, content: string) => ipcRenderer.invoke('project:writeFile', relativePath, content),
    createFile: (relativePath: string, content?: string) => ipcRenderer.invoke('project:createFile', relativePath, content),
    createDirectory: (relativePath: string) => ipcRenderer.invoke('project:createDirectory', relativePath),
    renamePath: (from: string, to: string) => ipcRenderer.invoke('project:renamePath', from, to),
    deletePath: (relativePath: string) => ipcRenderer.invoke('project:deletePath', relativePath),
    reveal: (relativePath?: string) => ipcRenderer.invoke('project:reveal', relativePath),
    exportArtifact: () => ipcRenderer.invoke('project:exportArtifact'),
    prepareIde: () => ipcRenderer.invoke('project:prepareIde'),
    openIde: () => ipcRenderer.invoke('project:openIde'),
    captureIdea: (prompt: string) => ipcRenderer.invoke('project:captureIdea', prompt),
    previewMigration: (input: ProjectMigrationInput) => ipcRenderer.invoke('project:previewMigration', input),
    migrate: (input: ProjectMigrationInput) => ipcRenderer.invoke('project:migrate', input)
  },
  build: {
    preflight: () => ipcRenderer.invoke('build:preflight'),
    respondTrust: (id: string, allow: boolean) => ipcRenderer.invoke('build:respondTrust', id, allow),
    onProgress: (listener: (event: PipelineEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PipelineEvent): void => listener(value)
      ipcRenderer.on('build:progress', handler)
      return () => ipcRenderer.removeListener('build:progress', handler)
    },
    onTrustRequired: (listener: (request: BuildTrustRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: BuildTrustRequest): void => listener(value)
      ipcRenderer.on('build:trustRequired', handler)
      return () => ipcRenderer.removeListener('build:trustRequired', handler)
    }
  },
  snapshots: {
    create: (label: string) => ipcRenderer.invoke('snapshots:create', label),
    list: () => ipcRenderer.invoke('snapshots:list'),
    restore: (id: string) => ipcRenderer.invoke('snapshots:restore', id),
    delete: (id: string) => ipcRenderer.invoke('snapshots:delete', id)
  },
  settings: {
    getAi: () => ipcRenderer.invoke('settings:getAi'),
    saveAi: (settings: AiSettings) => ipcRenderer.invoke('settings:saveAi', settings),
    listModels: (settings: AiSettings) => ipcRenderer.invoke('settings:listModels', settings)
  },
  ai: {
    createCode: (prompt: string, sessionId?: string, backend?: AiSettings['codingBackend']) => ipcRenderer.invoke('ai:createCode', prompt, sessionId, backend),
    cancelCode: () => ipcRenderer.invoke('ai:cancelCode'),
    getRecovery: () => ipcRenderer.invoke('ai:getRecovery'),
    resumeRecovery: () => ipcRenderer.invoke('ai:resumeRecovery'),
    restoreRecovery: () => ipcRenderer.invoke('ai:restoreRecovery'),
    inspire: (message: string, history: InspirationChatMessage[]) => ipcRenderer.invoke('ai:inspire', message, history),
    onProgress: (listener: (event: PipelineEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PipelineEvent): void => listener(value)
      ipcRenderer.on('ai:progress', handler)
      return () => ipcRenderer.removeListener('ai:progress', handler)
    },
    onOutput: (listener: (event: AiOutputEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AiOutputEvent): void => listener(value)
      ipcRenderer.on('ai:output', handler)
      return () => ipcRenderer.removeListener('ai:output', handler)
    }
  },
  externalAgents: {
    detect: () => ipcRenderer.invoke('external-agents:detect'),
    history: (kind: 'codex' | 'claude' | 'opencode') => ipcRenderer.invoke('external-agents:history', kind),
    install: (kind: 'codex' | 'claude' | 'opencode') => ipcRenderer.invoke('external-agents:install', kind),
    openDocs: (kind: 'codex' | 'claude' | 'opencode') => ipcRenderer.invoke('external-agents:openDocs', kind),
    launch: (kind: 'codex' | 'claude' | 'opencode') => ipcRenderer.invoke('external-agents:launch', kind)
  },
  blockbench: {
    show: (bounds: BlockbenchBounds) => ipcRenderer.invoke('blockbench:show', bounds),
    hide: () => ipcRenderer.invoke('blockbench:hide'),
    openProject: () => ipcRenderer.invoke('blockbench:openProject'),
    saveProject: () => ipcRenderer.invoke('blockbench:saveProject'),
    runAction: (action: string) => ipcRenderer.invoke('blockbench:runAction', action),
    execute: (action: BlockbenchAction) => ipcRenderer.invoke('blockbench:execute', action),
    getState: () => ipcRenderer.invoke('blockbench:getState'),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]): void => listener(value)
      ipcRenderer.on('blockbench:state', handler)
      void ipcRenderer.invoke('blockbench:getState').then(listener)
      return () => ipcRenderer.removeListener('blockbench:state', handler)
    }
  },
  mappings: {
    search: (version: string, query: string, limit?: number) => ipcRenderer.invoke('mappings:search', version, query, limit),
    getClass: (version: string, className: string, memberQuery?: string) =>
      ipcRenderer.invoke('mappings:getClass', version, className, memberQuery),
    openSource: (version: string) => ipcRenderer.invoke('mappings:openSource', version),
    openLoaderDocs: (loader) => ipcRenderer.invoke('mappings:openLoaderDocs', loader)
  },
  minecraft: {
    getState: () => ipcRenderer.invoke('minecraft:getState'),
    prepare: () => ipcRenderer.invoke('minecraft:prepare'),
    buildProject: () => ipcRenderer.invoke('minecraft:buildProject'),
    launch: (options: MinecraftLaunchOptions) => ipcRenderer.invoke('minecraft:launch', options),
    testLaunch: (options: MinecraftLaunchOptions) => ipcRenderer.invoke('minecraft:testLaunch', options),
    stop: () => ipcRenderer.invoke('minecraft:stop'),
    syncProjectMod: () => ipcRenderer.invoke('minecraft:syncProjectMod'),
    importMods: () => ipcRenderer.invoke('minecraft:importMods'),
    removeMod: (name: string) => ipcRenderer.invoke('minecraft:removeMod', name),
    listMods: () => ipcRenderer.invoke('minecraft:listMods'),
    onState: (listener: (state: MinecraftRuntimeState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: MinecraftRuntimeState): void => listener(value)
      ipcRenderer.on('minecraft:state', handler)
      return () => ipcRenderer.removeListener('minecraft:state', handler)
    },
    onEvent: (listener: (event: MinecraftRuntimeEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: MinecraftRuntimeEvent): void => listener(value)
      ipcRenderer.on('minecraft:event', handler)
      return () => ipcRenderer.removeListener('minecraft:event', handler)
    }
  },
  production: {
    dependencies: {
      search: (query: string, offset?: number) => ipcRenderer.invoke('dependencies:search', query, offset),
      versions: (projectId: string) => ipcRenderer.invoke('dependencies:versions', projectId),
      list: () => ipcRenderer.invoke('dependencies:list'),
      install: (input: DependencyInstallInput) => ipcRenderer.invoke('dependencies:install', input),
      installMaven: (input: MavenDependencyInput) => ipcRenderer.invoke('dependencies:installMaven', input),
      audit: () => ipcRenderer.invoke('dependencies:audit'),
      remove: (projectId: string) => ipcRenderer.invoke('dependencies:remove', projectId)
    },
    git: {
      status: () => ipcRenderer.invoke('git:status'),
      initialize: () => ipcRenderer.invoke('git:initialize'),
      diff: (relativePath?: string) => ipcRenderer.invoke('git:diff', relativePath),
      commit: (input: GitCommitInput) => ipcRenderer.invoke('git:commit', input),
      createBranch: (name: string) => ipcRenderer.invoke('git:createBranch', name),
      listRemotes: () => ipcRenderer.invoke('git:listRemotes'),
      addRemote: (name: string, url: string) => ipcRenderer.invoke('git:addRemote', name, url),
      removeRemote: (name: string) => ipcRenderer.invoke('git:removeRemote', name),
      fetch: (remote?: string) => ipcRenderer.invoke('git:fetch', remote),
      pull: (remote?: string, branch?: string) => ipcRenderer.invoke('git:pull', remote, branch),
      push: (remote?: string, branch?: string) => ipcRenderer.invoke('git:push', remote, branch),
      merge: (branch: string) => ipcRenderer.invoke('git:merge', branch),
      rebase: (branch: string) => ipcRenderer.invoke('git:rebase', branch),
      pullRequestUrl: (remote?: string) => ipcRenderer.invoke('git:pullRequestUrl', remote)
    },
    content: {
      create: (input: ContentCreateInput) => ipcRenderer.invoke('content:create', input),
      importAudio: (input: AudioImportInput) => ipcRenderer.invoke('content:importAudio', input),
      validate: () => ipcRenderer.invoke('content:validate')
    },
    tests: {
      runMatrix: (targets: TestTarget[]) => ipcRenderer.invoke('tests:runMatrix', targets),
      generateWorkflow: () => ipcRenderer.invoke('tests:generateWorkflow')
    },
    release: {
      getSettings: () => ipcRenderer.invoke('release:getSettings'),
      saveSettings: (settings: ReleaseSettings) => ipcRenderer.invoke('release:saveSettings', settings),
      preflight: () => ipcRenderer.invoke('release:preflight'),
      publish: (input: ReleasePublishInput) => ipcRenderer.invoke('release:publish', input)
    }
  }
}

contextBridge.exposeInMainWorld('modmind', api)
