import type { ServerPluginPlatform } from './types'

export type ServerCore = ServerPluginPlatform | 'purpur' | 'custom'
export interface ServerCoreBuild {
  core: ServerCore
  version: string
  build: string
  javaVersion: number
  url: string
  fileName: string
  checksum?: { algorithm: 'sha1' | 'sha256' | 'sha512' | 'md5'; value: string }
  channel: string
}
export interface ServerProfile {
  core: ServerCore
  version: string
  build?: string
  javaVersion: number
  memoryMb: number
  port: number
  onlineMode: boolean
  eulaAccepted: boolean
  localJar?: string
}
export interface PluginDescriptor {
  name: string
  version: string
  main: string
  platform: ServerPluginPlatform
  apiVersion?: string
  dependencies: Array<{ name: string; optional: boolean }>
  commands: string[]
  permissions: string[]
  foliaSupported: boolean
  file: string
}
export interface ServerPluginDependency { fileName: string; sha256: string; descriptor: PluginDescriptor }
export interface PluginDownloadVersion { id: string; name: string; version: string; files: Array<{ filename: string; url: string; hashes: { sha512?: string; sha1?: string } }> }
export interface ServerPluginApi {
  search: (projectPath: string, query: string) => Promise<Array<{ id: string; name: string; description: string }>>
  dependencyVersions: (projectPath: string, id: string) => Promise<PluginDownloadVersion[]>
  downloadDependency: (projectPath: string, versionId: string) => Promise<ServerPluginDependency[]>
  profile: (projectPath: string) => Promise<ServerProfile>
  saveProfile: (projectPath: string, profile: ServerProfile) => Promise<ServerProfile>
  versions: (core: ServerCore) => Promise<string[]>
  builds: (core: ServerCore, version: string) => Promise<ServerCoreBuild[]>
  importCore: (projectPath: string) => Promise<ServerProfile | null>
  dependencies: (projectPath: string) => Promise<ServerPluginDependency[]>
  importDependencies: (projectPath: string) => Promise<ServerPluginDependency[] | null>
  removeDependency: (projectPath: string, fileName: string) => Promise<void>
  inspect: (projectPath: string) => Promise<PluginDescriptor | null>
}
