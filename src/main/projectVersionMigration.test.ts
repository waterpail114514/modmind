import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { detectedProjectVersion, migrateProjectVersion112 } from './projectVersionMigration'

function oldProject(root: string): ProjectInfo {
  return {
    name: 'Old Project',
    path: root,
    loader: 'fabric',
    minecraftVersion: '1.21.1',
    loaderVersion: '0.16.10',
    apiVersion: '0.116.13+1.21.1',
    javaVersion: 21,
    namespace: 'old_project',
    createdAt: '2025-01-01T00:00:00.000Z',
    toolDataDirectory: '.modmind'
  }
}

async function writeOldTemplate(project: ProjectInfo): Promise<void> {
  await fs.mkdir(path.join(project.path, 'src', 'main', 'resources'), { recursive: true })
  await fs.mkdir(path.join(project.path, 'src', 'main', 'java'), { recursive: true })
  await fs.writeFile(path.join(project.path, 'README.md'), '# Old Project\n\nThis project was created with ModMind.\n', 'utf8')
  await fs.writeFile(path.join(project.path, 'build.gradle'), "plugins { id 'fabric-loom' version '1.10.5' }\n", 'utf8')
  await fs.writeFile(path.join(project.path, 'settings.gradle'), "rootProject.name = 'old_project'\n", 'utf8')
  await fs.writeFile(path.join(project.path, 'gradle.properties'), 'minecraft_version=1.21.1\n', 'utf8')
  await fs.writeFile(path.join(project.path, 'modmind.project.json'), JSON.stringify(project, null, 2), 'utf8')
  await fs.writeFile(path.join(project.path, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'old_project',
    version: '${version}',
    entrypoints: { main: ['custom.Entry'] },
    depends: { fabricloader: '>=0.14.0', custom_library: '>=2' }
  }, null, 2), 'utf8')
  await fs.writeFile(path.join(project.path, 'src', 'main', 'java', 'Custom.java'), 'class Custom {}\n', 'utf8')
}

async function fakeWrapper(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, 'gradle', 'wrapper'), { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'gradlew'), 'wrapper\n', 'utf8')
  await fs.writeFile(path.join(projectRoot, 'gradlew.bat'), 'wrapper\r\n', 'utf8')
  await fs.writeFile(path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'wrapper', 'utf8')
}

describe('project version migration', () => {
  it('reports an incomplete rollback and preserves the original backup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-rollback-error-'))
    const originalCopy = fs.copyFile.bind(fs)
    let backup = ''
    const copy = vi.spyOn(fs, 'copyFile').mockImplementation(async (source, target, flags) => {
      if (String(source).includes(`${path.sep}migrations${path.sep}`) && String(target) === path.join(root, 'build.gradle')) {
        backup = String(source)
        throw Object.assign(new Error('restore locked'), { code: 'EACCES' })
      }
      return originalCopy(source, target, flags)
    })
    try {
      const project = oldProject(root)
      await writeOldTemplate(project)
      const original = await fs.readFile(path.join(root, 'build.gradle'), 'utf8')
      await expect(migrateProjectVersion112(project, async () => { throw new Error('wrapper failed') })).rejects.toThrow('部分文件未能恢复')
      expect(await fs.readFile(backup, 'utf8')).toBe(original)
      expect(JSON.parse(await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8')).projectVersion).toBeUndefined()
    } finally {
      copy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  it('detects signed 1.1.2 templates but not imported custom projects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-project-version-'))
    try {
      const project = oldProject(root)
      await writeOldTemplate(project)
      expect(await detectedProjectVersion(project)).toBe('1.1.2')
      await fs.writeFile(path.join(root, 'README.md'), '# Imported project\n', 'utf8')
      expect(await detectedProjectVersion(project)).toBeNull()
      expect(await detectedProjectVersion({ ...project, projectVersion: '1.1.2' })).toBe('1.1.2')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('backs up and upgrades the template while preserving source and custom entrypoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-project-migrate-'))
    try {
      const project = oldProject(root)
      await writeOldTemplate(project)
      const result = await migrateProjectVersion112(project, fakeWrapper)
      expect(result.project.projectVersion).toBe('1.1.3')
      expect(await fs.readFile(path.join(root, 'build.gradle'), 'utf8')).toContain("net.fabricmc.fabric-loom-remap")
      expect(await fs.readFile(path.join(result.backupDirectory, 'build.gradle'), 'utf8')).toContain("id 'fabric-loom'")
      expect(await fs.readFile(path.join(root, 'src', 'main', 'java', 'Custom.java'), 'utf8')).toBe('class Custom {}\n')
      const descriptor = JSON.parse(await fs.readFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8'))
      expect(descriptor.entrypoints).toEqual({ main: ['custom.Entry'] })
      expect(descriptor.depends.custom_library).toBe('>=2')
      expect(JSON.parse(await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8')).projectVersion).toBe('1.1.3')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('restores original files when Wrapper installation fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-project-rollback-'))
    try {
      const project = oldProject(root)
      await writeOldTemplate(project)
      const oldBuild = await fs.readFile(path.join(root, 'build.gradle'), 'utf8')
      await expect(migrateProjectVersion112(project, async () => { throw new Error('wrapper failed') })).rejects.toThrow('wrapper failed')
      expect(await fs.readFile(path.join(root, 'build.gradle'), 'utf8')).toBe(oldBuild)
      expect(JSON.parse(await fs.readFile(path.join(root, 'modmind.project.json'), 'utf8')).projectVersion).toBeUndefined()
      await expect(fs.access(path.join(root, 'modmind.template.json'))).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
