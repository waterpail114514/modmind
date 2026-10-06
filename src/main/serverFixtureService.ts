import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { coerce, satisfies, valid, validRange } from 'semver'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import type { ProjectInfo } from '../shared/types'
import type { ServerFixtureInput, ServerFixtureJar, ServerFixtureMod } from '../shared/serverScenario'

interface Dependency { id: string; range: unknown; kind: 'required' | 'incompatible' }
interface ModMetadata extends ServerFixtureMod { dependencies: Dependency[] }
const MAX_BYTES = 1024 * 1024 * 1024

export async function fixtureJarHash(file: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size < 1 || stat.size > 512 * 1024 * 1024 || !file.toLowerCase().endsWith('.jar')) throw new Error(`测试输入不是有效 JAR：${file}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk) }
  return { sha256: hash.digest('hex'), size: stat.size }
}

/** Numeric Maven intervals are translated; unsupported versions fail closed. */
export function fixtureVersionMatches(version: string, range: unknown, maven = false): boolean {
  if (Array.isArray(range)) return range.some(entry => fixtureVersionMatches(version, entry, maven))
  if (typeof range !== 'string' || range.length > 500) throw new Error('无法校验依赖版本声明')
  if (range === '*' || range === '') return true
  const parsed = valid(version) ?? coerce(version)?.version
  if (!parsed || !/^\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?$/.test(version)) throw new Error(`无法校验模组版本：${version}`)
  let expression = range
  if (maven && /^[[(]/.test(range)) {
    const exact = range.match(/^\[([\d.]+)\]$/)
    if (exact) expression = `=${coerce(exact[1])?.version ?? 'invalid'}`
    else {
      const interval = range.match(/^([[(])([\d.]*),([\d.]*)([)\]])$/)
      if (!interval) throw new Error(`暂不支持该 Maven 版本范围：${range}`)
      expression = [interval[2] ? `${interval[1] === '[' ? '>=' : '>'}${coerce(interval[2])?.version ?? 'invalid'}` : '', interval[3] ? `${interval[4] === ']' ? '<=' : '<'}${coerce(interval[3])?.version ?? 'invalid'}` : ''].filter(Boolean).join(' ') || '*'
    }
  }
  if (!validRange(expression)) throw new Error(`无法校验依赖版本范围：${range}`)
  return satisfies(parsed, expression, { includePrerelease: true })
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('测试 JAR 缺少有效的模组标识或版本')
  return value.trim()
}

async function metadata(file: string, input: ServerFixtureInput, embedded = false, depth = 0, budget = { count: 0 }): Promise<ModMetadata[]> {
  if (depth > 4 || ++budget.count > 128) throw new Error('内嵌模组数量或层数超过测试上限')
  const entries = await archiveEntries(file)
  const mods: ModMetadata[] = []
  const dependency = (id: unknown, range: unknown, kind: Dependency['kind']): Dependency => ({ id: text(id), range, kind })
  const maven = input.loader === 'forge' || input.loader === 'neoforge'
  if (maven) {
    const descriptor = input.loader === 'neoforge' && entries.includes('META-INF/neoforge.mods.toml') ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml'
    if (entries.includes(descriptor)) {
      const value = parseToml((await archiveRead(file, descriptor)).toString('utf8')) as Record<string, any>
      const manifest = entries.includes('META-INF/MANIFEST.MF') ? (await archiveRead(file, 'META-INF/MANIFEST.MF')).toString('utf8') : ''
      const jarVersion = manifest.match(/^Implementation-Version:\s*(.+)$/mi)?.[1]?.trim()
      for (const mod of value.mods ?? []) {
        const id = text(mod.modId)
        const dependencies: Dependency[] = []
        for (const dep of value.dependencies?.[id] ?? []) {
          if (dep.side === 'CLIENT') continue
          if (dep.mandatory === true || dep.type === 'required' || dep.type === 'incompatible') dependencies.push(dependency(dep.modId, dep.versionRange ?? '*', dep.type === 'incompatible' ? 'incompatible' : 'required'))
        }
        mods.push({ id, version: text(mod.version === '${file.jarVersion}' ? jarVersion : mod.version), file, embedded, dependencies })
      }
    }
    if (entries.includes('META-INF/jarjar/metadata.json')) {
      const nested = JSON.parse((await archiveRead(file, 'META-INF/jarjar/metadata.json')).toString('utf8'))
      for (const jar of nested.jars ?? []) {
        if (typeof jar.path !== 'string' || !entries.includes(jar.path)) throw new Error('JAR 内嵌依赖缺失')
        mods.push(...await metadata(`${file}!/${jar.path}`, input, true, depth + 1, budget))
      }
    }
  } else {
    const descriptor = input.loader === 'quilt' && entries.includes('quilt.mod.json') ? 'quilt.mod.json' : 'fabric.mod.json'
    if (entries.includes(descriptor)) {
      const value = JSON.parse((await archiveRead(file, descriptor)).toString('utf8'))
      if (value.environment === 'client') throw new Error(`测试输入包含仅客户端模组：${file}`)
      const loader = descriptor === 'quilt.mod.json' ? value.quilt_loader : value
      const dependencies: Dependency[] = []
      if (descriptor === 'quilt.mod.json') {
        for (const dep of loader.depends ?? []) {
          if (typeof dep === 'string') dependencies.push(dependency(dep, '*', 'required'))
          else if (!dep.optional) dependencies.push(dependency(dep.id, dep.versions ?? '*', 'required'))
        }
      } else {
        for (const [id, range] of Object.entries(value.depends ?? {})) dependencies.push(dependency(id, range, 'required'))
        for (const [id, range] of Object.entries(value.breaks ?? {})) dependencies.push(dependency(id, range, 'incompatible'))
      }
      mods.push({ id: text(loader.id), version: text(loader.version), file, embedded, dependencies })
      for (const jar of value.jars ?? loader.jars ?? []) {
        if (typeof jar.file !== 'string' || !entries.includes(jar.file)) throw new Error('JAR 内嵌依赖缺失')
        mods.push(...await metadata(`${file}!/${jar.file}`, input, true, depth + 1, budget))
      }
    }
  }
  if (!embedded && !mods.length) throw new Error(`测试 JAR 没有匹配 ${input.loader} 的可校验模组描述：${file}`)
  return mods
}

export class ServerFixtureService {
  private readonly selected = new Map<string, ServerFixtureJar[]>()

  list(project: ProjectInfo): ServerFixtureJar[] { return structuredClone(this.selected.get(path.resolve(project.path)) ?? []) }

  remove(project: ProjectInfo, file: string): ServerFixtureJar[] {
    this.selected.set(path.resolve(project.path), this.list(project).filter(jar => jar.path !== file))
    return this.list(project)
  }

  async select(project: ProjectInfo, paths: string[]): Promise<ServerFixtureJar[]> {
    if (paths.length > 64) throw new Error('一次最多选择 64 个测试 JAR')
    const jars: ServerFixtureJar[] = []
    let size = 0
    for (const file of paths) {
      const canonical = await fs.realpath(file)
      size += (await fs.stat(canonical)).size
      if (size > MAX_BYTES) throw new Error('测试 JAR 总量超过 1 GiB')
      jars.push({ path: canonical, sha256: (await fixtureJarHash(canonical)).sha256, name: path.basename(file) })
    }
    this.selected.set(path.resolve(project.path), jars)
    while (this.selected.size > 16) this.selected.delete(this.selected.keys().next().value!)
    return structuredClone(jars)
  }

  async stage(project: ProjectInfo, input: ServerFixtureInput, destination: string, signal: AbortSignal): Promise<{ jars: Array<ServerFixtureJar & { size: number }>; mods: ServerFixtureMod[]; javaConstraints: Array<{ modId: string; range: unknown; kind: Dependency['kind'] }> }> {
    if (!input || !Array.isArray(input.jars) || !input.jars.length || input.jars.length > 64) throw new Error('隔离测试需要 1–64 个 JAR')
    const root = await fs.realpath(project.path)
    const authorized = this.list(project)
    const jars: Array<ServerFixtureJar & { size: number }> = []
    let bytes = 0
    const mods: ModMetadata[] = []
    await fs.mkdir(path.join(destination, 'mods'), { recursive: true })
    for (const jar of input.jars) {
      signal.throwIfAborted()
      if (typeof jar.path !== 'string' || !/^[a-f0-9]{64}$/i.test(jar.sha256)) throw new Error('测试 JAR 必须提供路径和 SHA-256')
      const file = await fs.realpath(path.resolve(project.path, jar.path))
      const relative = path.relative(root, file)
      const inside = relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
      if (!inside && !authorized.some(entry => entry.path === file && entry.sha256.toLowerCase() === jar.sha256.toLowerCase())) throw new Error('项目外测试 JAR 未通过文件选择器授权')
      const name = path.basename(file)
      if (jars.some(entry => entry.name?.toLowerCase() === name.toLowerCase())) throw new Error(`测试 JAR 文件名重复：${name}`)
      const output = path.join(destination, 'mods', name)
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size < 1 || stat.size > 512 * 1024 * 1024 || bytes + stat.size > MAX_BYTES) throw new Error('测试 JAR 文件大小超过上限')
      await fs.copyFile(file, output)
      const hash = await fixtureJarHash(output, signal)
      if (hash.sha256 !== jar.sha256.toLowerCase()) throw new Error(`测试 JAR 已变化或 SHA-256 不符：${name}`)
      bytes += hash.size
      if (bytes > MAX_BYTES) throw new Error('测试 JAR 总量超过 1 GiB')
      jars.push({ path: file, name, ...hash })
      const discovered = await metadata(output, input).catch(error => { throw new Error(`无法校验 ${name}：${String(error)}`, { cause: error }) })
      mods.push(...discovered.map(mod => ({ ...mod, file: mod.file.replace(output, name) })))
    }
    const versions = new Map<string, string>([
      ['minecraft', input.minecraftVersion],
      [input.loader === 'fabric' ? 'fabricloader' : input.loader === 'quilt' ? 'quilt_loader' : input.loader, input.loader === 'forge' ? input.loaderVersion.replace(`${input.minecraftVersion}-`, '') : input.loaderVersion]
    ])
    for (const mod of mods) {
      if (versions.has(mod.id)) throw new Error(`测试模组 ID 重复：${mod.id}`)
      versions.set(mod.id, mod.version)
    }
    for (const mod of mods) for (const dep of mod.dependencies) {
      if (dep.id === 'java') continue
      const version = versions.get(dep.id)
      if (dep.kind === 'required' && !version) throw new Error(`${mod.id} 缺少必需依赖 ${dep.id}`)
      if (version) {
        const matches = fixtureVersionMatches(version, dep.range, input.loader === 'forge' || input.loader === 'neoforge')
        if (dep.kind === 'required' && !matches || dep.kind === 'incompatible' && matches) throw new Error(`${mod.id} 与 ${dep.id} ${version} 的依赖约束不匹配：${String(dep.range)}`)
      }
    }
    return { jars, mods: mods.map(({ dependencies: _dependencies, ...mod }) => mod), javaConstraints: mods.flatMap(mod => mod.dependencies.filter(dep => dep.id === 'java').map(dep => ({ modId: mod.id, range: dep.range, kind: dep.kind }))) }
  }
}
