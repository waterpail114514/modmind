export interface ResourcePackInfo {
  id: string
  path: string
  name: string
  description: string
  packFormat: number | null
  files: Array<{ path: string; size: number; kind: 'image' | 'text' | 'audio' | 'binary' }>
}
export interface ResourcePackIssue { severity: 'error' | 'warning'; path: string; message: string }
export interface ResourcePackValidation { success: boolean; checked: number; issues: ResourcePackIssue[] }
export interface ResourcePackCreate { name: string; description: string; packFormat: number }
export interface ResourcePackApi {
  list: (projectPath: string) => Promise<ResourcePackInfo[]>
  create: (projectPath: string, input: ResourcePackCreate) => Promise<ResourcePackInfo>
  import: (projectPath: string, directory?: boolean) => Promise<ResourcePackInfo | null>
  read: (projectPath: string, id: string, file: string) => Promise<{ text?: string; dataUrl?: string; baseline: string }>
  write: (projectPath: string, id: string, file: string, content: string, baseline: string | null) => Promise<ResourcePackInfo>
  importAssets: (projectPath: string, id: string, directory: string) => Promise<ResourcePackInfo | null>
  removeFile: (projectPath: string, id: string, file: string, baseline: string) => Promise<ResourcePackInfo>
  validate: (projectPath: string, id: string) => Promise<ResourcePackValidation>
  export: (projectPath: string, id: string) => Promise<string | null>
  deploy: (projectPath: string, id: string) => Promise<{ path: string; message: string }>
}

export function suggestedResourcePackFormat(version: string): number | null {
  const formats: Record<string, number> = { '1.17': 7, '1.17.1': 7, '1.18': 8, '1.18.1': 8, '1.18.2': 8, '1.19': 9, '1.19.1': 9, '1.19.2': 9, '1.19.3': 12, '1.19.4': 13, '1.20': 15, '1.20.1': 15, '1.20.2': 18, '1.20.3': 22, '1.20.4': 22, '1.20.5': 32, '1.20.6': 32, '1.21': 34, '1.21.1': 34, '1.21.2': 42, '1.21.3': 42, '1.21.4': 46, '1.21.5': 55, '1.21.6': 63, '1.21.7': 64, '1.21.8': 64 }
  return formats[version] ?? null
}
