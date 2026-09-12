import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { managedJavaExecutable, normalizeRuntimeMetadata } from './runtimeMetadata'
import type { ProjectInfo } from '../shared/types'

describe('runtime metadata relocation', () => {
  it('derives managed Java from the current runtime root', () => {
    const project: ProjectInfo = {
      name: 'Moved project',
      path: 'C:/Projects/moved-project',
      loader: 'fabric',
      minecraftVersion: '1.21.11',
      namespace: 'moved_project',
      createdAt: new Date().toISOString()
    }
    const metadata = normalizeRuntimeMetadata(project, {
      minecraftVersion: '1.21.11',
      loader: 'fabric',
      loaderVersionId: 'fabric-loader-0.19.3-1.21.11',
      loaderVersion: '0.19.3',
      javaPath: 'C:/Users/old-user/AppData/Roaming/modmind/minecraft-runtime/java/java-runtime-delta/bin/java.exe',
      javaTarget: 'java-runtime-delta',
      preparedAt: new Date().toISOString()
    }, 'C:/Users/new-user/AppData/Roaming/modmind/minecraft-runtime/java')

    expect(metadata?.javaPath).toBe(managedJavaExecutable('C:/Users/new-user/AppData/Roaming/modmind/minecraft-runtime/java', 'java-runtime-delta'))
    expect(metadata?.javaPath).not.toContain('old-user')
    expect(metadata?.javaTarget).toBe('java-runtime-delta')
  })

  it('rejects metadata for a different Minecraft version', () => {
    const project: ProjectInfo = {
      name: 'Moved project',
      path: 'C:/Projects/moved-project',
      loader: 'fabric',
      minecraftVersion: '1.21.11',
      namespace: 'moved_project',
      createdAt: new Date().toISOString()
    }

    expect(normalizeRuntimeMetadata(project, {
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      loaderVersionId: 'fabric-loader-0.16.0-1.20.1',
      loaderVersion: '0.16.0',
      javaPath: 'C:/old/java.exe',
      javaTarget: 'java-runtime-gamma',
      preparedAt: new Date().toISOString()
    }, path.join('C:/Users/new-user', 'minecraft-runtime', 'java'))).toBeNull()
  })
})
