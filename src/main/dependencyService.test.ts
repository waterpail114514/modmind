import { applyManagedDependencies } from '../../feature-plugins/relationships/src/main/dependencyService'
import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateManagedGradleDependencies } from "../../feature-plugins/relationships/src/main/dependencyService"
import { DependencyService } from "../../feature-plugins/relationships/src/main/dependencyService"
import type { ManagedDependency } from '../shared/production'
import type { ProjectInfo } from '../shared/types'
import { isJavaLoader } from '../shared/projectPlatform'
import { bundledLoaderCatalog } from './loaderCatalog'
import { projectTemplateFiles } from './projectTemplates'

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

  it.each([
    ['apostrophe in a line comment', "    // Don't remove the Minecraft dependency"],
    ['opening brace in a line comment', '    // Example: dependencies {'],
    ['closing brace in a line comment', '    // } is only an example'],
    ['quotes and braces in a block comment', '    /* Don\'t count {, }, or " here */'],
    ['escaped quotes', String.raw`    def label = "escaped \" {"`],
    ['triple single quotes', `    def label = '''Don't count " or { here'''`],
    ['triple double quotes', `    def label = """Don't count " or { here"""`],
    ['slashy strings', String.raw`    def pattern = /Don't count " or { or \/ here/`],
    ['dollar slashy strings', '    def pattern = $/Don\'t count " or { or $/ here/$'],
    ['interpolation with nested strings', '    def label = "${project.findProperty("label") ?: "}"}"'],
    ['interpolation with nested closures', '    def label = "${[1].collect { value -> "${value}}" }.join("{")}"'],
    ['division expressions', '    def ratio = (8 / 2) + [4][0] / 2'],
    ['ordinary identifier names', '    def label = toString()'],
    ['nested closures', '    implementation("x:y:1") { exclude group: "example" }']
  ])('preserves the dependency block with %s', (_name, content) => {
    const prefix = `plugins { id 'java' }\ndependencies {\n${content}\n    implementation 'fixture:existing:1'\n`
    const suffix = '}\nprintln("after dependencies")\n'
    const first = updateManagedGradleDependencies(prefix + suffix, project, [dependency], false)
    const second = updateManagedGradleDependencies(first, project, [dependency], false)
    expect(second.startsWith(prefix)).toBe(true)
    expect(second.endsWith(suffix)).toBe(true)
    expect(second.slice(prefix.length, -suffix.length)).toContain("modImplementation files('libs/modmind/example.jar')")
    expect(second.match(/MODMIND DEPENDENCIES START/g)).toHaveLength(1)
  })

  it('handles Windows line endings in comments and repeated updates', () => {
    const prefix = 'dependencies {\r\n    // Don\'t count { or } here\r\n'
    const suffix = '}\r\n'
    const first = updateManagedGradleDependencies(prefix + suffix, project, [dependency], false)
    const second = updateManagedGradleDependencies(first, project, [dependency], false)
    expect(second).toBe(first)
    expect(second.startsWith(prefix)).toBe(true)
    expect(second.endsWith(suffix)).toBe(true)
    expect(second.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it.each(bundledLoaderCatalog().filter((option) => isJavaLoader(option.loader)))('updates the bundled $loader $minecraftVersion template', (option) => {
    const currentProject = { ...project, ...option }
    const source = projectTemplateFiles(currentProject, false)['build.gradle']
    const result = updateManagedGradleDependencies(source, currentProject, [dependency], false)
    expect(result).toContain('libs/modmind/example.jar')
    expect(updateManagedGradleDependencies(result, currentProject, [dependency], false)).toBe(result)
    if (source.startsWith('buildscript {')) {
      const buildscript = source.slice(0, source.indexOf('\n}\n') + 3)
      expect(result.startsWith(buildscript)).toBe(true)
    }
  })

  it.each([false, true])('ignores commented, quoted and nested dependency blocks (Kotlin: %s)', (kotlin) => {
    const prefix = [
      '// dependencies {',
      '/* dependencies { } */',
      `${kotlin ? 'val' : 'def'} label = "dependencies {"`,
      'buildscript {',
      '    dependencies { /* Keep the plugin classpath unchanged. */ }',
      '}',
      'custom.dependencies { }',
      ''
    ].join('\n')
    const result = updateManagedGradleDependencies(`${prefix}dependencies /* project dependencies */ {\n}\n`, project, [dependency], kotlin)
    expect(result.startsWith(prefix)).toBe(true)
    expect(result.indexOf('MODMIND DEPENDENCIES START')).toBeGreaterThan(result.indexOf('/* project dependencies */'))
    expect(result).toContain(kotlin ? 'modImplementation(files("libs/modmind/example.jar"))' : "modImplementation files('libs/modmind/example.jar')")

    const appended = updateManagedGradleDependencies(prefix, project, [dependency], kotlin)
    expect(appended.startsWith(prefix)).toBe(true)
    expect(appended.slice(prefix.length)).toContain('dependencies {')
  })

  it.each([
    '    /* outer /* nested */ Don\'t count } or " */',
    '    val label = """raw text \\"""',
    '    val label = "${project.findProperty("label") ?: "}"}"',
    "    val brace = '{'"
  ])('handles Kotlin comments and strings: %s', (content) => {
    const prefix = `dependencies {\n${content}\n`
    const result = updateManagedGradleDependencies(`${prefix}}\n`, project, [dependency], true)
    expect(result.startsWith(prefix)).toBe(true)
    expect(result.endsWith('}\n')).toBe(true)
    expect(result.slice(prefix.length, -2)).toContain('modImplementation(files("libs/modmind/example.jar"))')
  })

  it.each([
    'dependencies {',
    'dependencies { /* unclosed comment }',
    'dependencies { "unclosed string }',
    'dependencies { implementation("x:y:1" }',
    'buildscript { dependencies {}',
    '// dependencies {\n/* unclosed comment'
  ])('refuses to rewrite an incomplete Gradle script: %s', (source) => {
    expect(() => updateManagedGradleDependencies(source, project, [dependency], false)).toThrow('无法安全更新 Gradle dependencies 块')
  })

  it.each([false, true])('updates project Maven repositories without changing the buildscript (Kotlin: %s)', async (kotlin) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-gradle-comments-'))
    try {
      const prefix = 'buildscript {\n    repositories { mavenCentral() }\n    dependencies {}\n}\n'
      const source = `${prefix}// repositories {\nrepositories /* project repositories */ {\n    // Don't count { here\n    mavenCentral()\n}\ndependencies {\n    /* Don't count { or " here */\n}\n`
      const gradlePath = path.join(root, kotlin ? 'build.gradle.kts' : 'build.gradle')
      await fs.writeFile(gradlePath, source)
      const currentProject = { ...project, path: root }
      const maven: ManagedDependency = { ...dependency, source: 'maven', coordinate: 'example:api:1', repository: 'https://repo.example.com/releases' }
      await applyManagedDependencies(currentProject, [maven])
      const first = await fs.readFile(gradlePath, 'utf8')
      await applyManagedDependencies(currentProject, [maven])
      const second = await fs.readFile(gradlePath, 'utf8')
      expect(second).toBe(first)
      expect(second.startsWith(prefix)).toBe(true)
      expect(second.indexOf('MODMIND REPOSITORIES START')).toBeGreaterThan(second.indexOf('/* project repositories */'))
      expect(second.indexOf('MODMIND REPOSITORIES END')).toBeLessThan(second.indexOf('\ndependencies {'))
      expect(second).toContain(kotlin ? 'maven("https://repo.example.com/releases")' : "maven { url = 'https://repo.example.com/releases' }")
      await applyManagedDependencies(currentProject, [])
      const removed = await fs.readFile(gradlePath, 'utf8')
      expect(removed.startsWith(prefix)).toBe(true)
      expect(removed).toContain("// Don't count { here")
      expect(removed).not.toContain('MODMIND')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('restores the Gradle script and dependency manifest on parse failure (existing manifest: %s)', async (existingManifest) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-gradle-rollback-'))
    try {
      const gradlePath = path.join(root, 'build.gradle')
      const manifestPath = path.join(root, 'modmind.dependencies.json')
      const source = 'dependencies { /* unfinished comment }\n'
      const manifest = JSON.stringify({ version: 1, dependencies: [] }, null, 2)
      await fs.writeFile(gradlePath, source)
      if (existingManifest) await fs.writeFile(manifestPath, manifest)
      await expect(applyManagedDependencies({ ...project, path: root }, [dependency])).rejects.toThrow('无法安全更新 Gradle dependencies 块')
      await expect(fs.readFile(gradlePath, 'utf8')).resolves.toBe(source)
      if (existingManifest) await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(manifest)
      else await expect(fs.access(manifestPath)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
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
