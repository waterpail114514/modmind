import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateManagedGradleDependencies } from "../../feature-plugins/relationships/src/main/dependencyService"
import { DependencyService } from "../../feature-plugins/relationships/src/main/dependencyService"
import type { ManagedDependency } from '../shared/production'
import type { ProjectInfo } from '../shared/types'

const project: ProjectInfo = {
  name: 'Test', path: 'C:/test', loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'test', createdAt: ''
}
const dependency: ManagedDependency = {
  projectId: 'abc', versionId: 'v1', slug: 'example', name: 'Example', versionNumber: '1.0.0', fileName: 'example.jar',
  relativePath: 'libs/modmind/example.jar', installedAt: '', environment: 'both'
}

describe('managed Gradle dependencies', () => {
  it('adds and replaces a generated block without duplicating dependencies', () => {
    const source = "plugins { id 'java' }\n\ndependencies {\n    implementation 'x:y:1'\n}\n"
    const first = updateManagedGradleDependencies(source, project, [dependency], false)
    const second = updateManagedGradleDependencies(first, project, [dependency], false)
    expect(second.match(/MODMIND DEPENDENCIES START/g)).toHaveLength(1)
    expect(second).toContain("modImplementation files('libs/modmind/example.jar')")
    expect(second).toContain("implementation 'x:y:1'")
  })

  it('creates a dependencies block when a template does not have one', () => {
    const result = updateManagedGradleDependencies("plugins { id 'java' }\n", { ...project, loader: 'neoforge' }, [dependency], false)
    expect(result).toContain('dependencies {')
    expect(result).toContain("implementation files('libs/modmind/example.jar')")
  })

  it('manages Maven coordinates and HTTPS repositories transactionally', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-maven-'))
    try {
      await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies {}\n", 'utf8')
      const service = new DependencyService(
        () => ({ ...project, path: root, loader: 'quilt' }),
        async () => undefined,
        async () => undefined
      )
      const installed = await service.installMaven({
        coordinate: 'com.example:crystal-api:2.1.0',
        repository: 'https://repo.example.com/releases/',
        configuration: 'modImplementation'
      })
      await service.installMaven({
        coordinate: 'com.example:crystal-api:2.1.0',
        repository: 'https://repo.example.com/releases/',
        configuration: 'modImplementation'
      })
      const gradle = await fs.readFile(path.join(root, 'build.gradle'), 'utf8')
      expect(gradle).toContain("modImplementation 'com.example:crystal-api:2.1.0'")
      expect(gradle).toContain("maven { url = 'https://repo.example.com/releases' }")
      expect(gradle.match(/MODMIND REPOSITORIES START/g)).toHaveLength(1)
      expect(gradle.match(/MODMIND DEPENDENCIES START/g)).toHaveLength(1)
      await expect(service.audit()).resolves.toMatchObject({ success: true, checked: 1 })
      await expect(service.installMaven({ coordinate: 'broken', repository: 'http://insecure.example.com' })).rejects.toThrow()
      await expect(service.remove(installed.projectId)).resolves.toEqual([])
      const removed = await fs.readFile(path.join(root, 'build.gradle'), 'utf8')
      expect(removed).not.toContain('MODMIND REPOSITORIES')
      expect(removed).not.toContain('MODMIND DEPENDENCIES')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
