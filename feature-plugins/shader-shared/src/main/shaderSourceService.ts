import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { retryTransientFileLock } from '../../../../src/main/fileLockRetry'
import type { ProjectInfo } from '../../../../src/shared/types'
import type { ShaderDocument, ShaderInventory } from '../../../../src/shared/shaderStudio'
import { MAX_FILE, assertShaderProject, hash, textExtension, stages, safeFile, serial, walk, relativePath } from './shaderFiles'
import { parseShaderOptions, programName } from './shaderOptionParser'

export async function readShaderFile(project: ProjectInfo, file: string): Promise<ShaderDocument> {
  assertShaderProject(project)
  if (!file.startsWith('shaders/') || !textExtension.test(file)) throw new Error('只能编辑 shaders 内的文本文件')
  const target = await safeFile(project.path, file), stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('文本文件不是普通文件或超过 2 MiB')
  const content = await fs.readFile(target, 'utf8')
  return { path: file, content, revision: hash(content) }
}
export async function shaderInventory(project: ProjectInfo): Promise<ShaderInventory> {
  assertShaderProject(project)
  const files = await walk(project.path), fingerprints: string[] = [], sources: Array<{ path: string; content: string }> = []
  const programs = new Map<string, string[]>()
  let config = '', language = ''
  for (const file of files) {
    if (file.size > MAX_FILE && file.kind === 'shader') throw new Error(`着色器超过 2 MiB：${file.path}`)
    const bytes = await fs.readFile(await safeFile(project.path, file.path)); fingerprints.push(`${file.path}:${hash(bytes)}`)
    if (stages.test(file.path)) { const name = file.path.replace(stages, ''); programs.set(name, [...(programs.get(name) ?? []), path.extname(file.path).slice(1)]) }
    if (file.kind === 'shader') sources.push({ path: file.path, content: bytes.toString('utf8') })
    if (file.path === 'shaders/shaders.properties') config = bytes.toString('utf8')
    if (file.path === 'shaders/lang/zh_cn.lang') language = bytes.toString('utf8')
  }
  return { revision: hash(fingerprints.join('\n')), files, programs: [...programs].map(([name, stages]) => ({ name, stages })),
    ...parseShaderOptions(sources, config, language, [...programs.keys()]) }
}
async function commitFiles(project: ProjectInfo, updates: Array<{ path: string; before: string; after: string }>): Promise<void> {
  const history = path.join(project.path, '.modmind', 'shader-history', randomUUID())
  await safeFile(project.path, '.modmind/shader-history', true); await fs.mkdir(history, { recursive: true })
  await fs.writeFile(path.join(history, 'changes.json'), JSON.stringify(updates))
  const written: typeof updates = []
  try {
    for (const update of updates) {
      const target = await safeFile(project.path, update.path)
      if (await fs.readFile(target, 'utf8') !== update.before) throw new Error('文件已变化，请重新读取后保存')
      const temporary = `${target}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, update.after); await retryTransientFileLock(() => fs.rename(temporary, target)) } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      written.push(update)
    }
    await fs.writeFile(path.join(history, 'committed'), new Date().toISOString())
    try {
    const historyRoot = path.dirname(history)
    const folders = await Promise.all((await fs.readdir(historyRoot)).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(async name => {
      const file = await safeFile(project.path, `.modmind/shader-history/${name}/changes.json`)
      const stat = await fs.stat(file)
      return { name, bytes: stat.size, time: stat.mtimeMs }
    }))
    let retained = 0
    for (const [i, entry] of folders.sort((a, b) => b.time - a.time).entries()) {
      retained += entry.bytes
      if (entry.name !== path.basename(history) && (i >= 20 || retained > 32 * 1024 * 1024)) {
        await fs.rm(await safeFile(project.path, `.modmind/shader-history/${entry.name}`), { recursive: true })
      }
    }
    } catch { /* A retained old record does not invalidate the saved source files. */ }
  } catch (error) {
    for (const update of written.reverse()) {
      const target = await safeFile(project.path, update.path)
      if (await fs.readFile(target, 'utf8') === update.after) await fs.writeFile(target, update.before)
    }
    throw error
  }
}
export async function saveShaderFile(project: ProjectInfo, file: string, content: string, revision: string): Promise<ShaderDocument> {
  assertShaderProject(project)
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE || content.includes('\0')) throw new Error('着色器文本无效或超过 2 MiB')
  return serial(project.path, async () => {
    const original = await readShaderFile(project, file)
    if (original.revision !== revision) throw new Error('文件已变化，请重新读取后保存')
    await commitFiles(project, [{ path: file, before: original.content, after: content }])
    return readShaderFile(project, file)
  })
}
export async function setShaderOptions(project: ProjectInfo, revision: string, values: Record<string, string>, programValues: Record<string, boolean> = {}): Promise<ShaderInventory> {
  assertShaderProject(project)
  return serial(project.path, async () => {
    const inventory = await shaderInventory(project)
    if (inventory.revision !== revision) throw new Error('工程已变化，请刷新选项后重试')
    if (!values || typeof values !== 'object' || Array.isArray(values) || !programValues || typeof programValues !== 'object' || Array.isArray(programValues)) throw new Error('选项参数无效')
    if (Object.keys(values).length > 128 || Object.keys(programValues).length > 128) throw new Error('一次最多修改 128 个选项或程序')
    const documents = new Map<string, ShaderDocument>()
    for (const [name, value] of Object.entries(values)) {
      const option = inventory.options.find(option => option.name === name)
      if (!option || !option.values.includes(value)) throw new Error(`选项值无效：${name}`)
      for (const file of option.files) if (!documents.has(file.path)) documents.set(file.path, await readShaderFile(project, file.path))
    }
    if (Object.keys(programValues).length) {
      if (inventory.configurationConditional) throw new Error('条件 shaders.properties 需要在 Iris 中确认；未修改程序开关')
      for (const [name, value] of Object.entries(programValues)) if (!programName.test(name) || typeof value !== 'boolean' || !inventory.programs.some(program => program.name === `shaders/${name}`)) throw new Error(`程序开关无效：${name}`)
      documents.set('shaders/shaders.properties', await readShaderFile(project, 'shaders/shaders.properties'))
    }
    if ((await shaderInventory(project)).revision !== revision) throw new Error('读取选项时工程已变化，请刷新后重试')
    const updates = [...documents.values()].map(document => {
      const lines = document.content.split('\n')
      for (const [name, value] of Object.entries(values)) for (const file of inventory.options.find(option => option.name === name)!.files.filter(file => file.path === document.path)) {
        const line = lines[file.line - 1]
        const declaration = inventory.options.find(option => option.name === name)!.declaration
        lines[file.line - 1] = declaration === 'const' ? line.replace(/(\bconst\s+(?:int|float|bool)\s+\w+\s*=\s*)([^\s;]+)/, (_, prefix) => prefix + value)
          : declaration === 'define' ? line.replace(/(#define\s+\w+\s+)([^\s/]+)/, (_, prefix) => prefix + value)
          : value === 'true' ? line.replace(/^(\s*)\/\/\s*(#define)/, '$1$2') : /^\s*\/\//.test(line) ? line : line.replace(/^(\s*)(#define)/, '$1// $2')
      }
      if (document.path === 'shaders/shaders.properties') for (const [name, value] of Object.entries(programValues)) {
        const key = `program.${name}.enabled`, pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
        const positions = lines.map((line, index) => pattern.test(line) ? index : -1).filter(index => index >= 0)
        if (positions.length > 1 || positions.some(index => /\\\r?$/.test(lines[index]))) throw new Error(`程序配置重复或跨行，未修改：${name}`)
        const replacement = `${key}=${value}${document.content.includes('\r\n') ? '\r' : ''}`
        if (positions.length) lines[positions[0]] = replacement
        else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, replacement)
      }
      return { path: document.path, before: document.content, after: lines.join('\n') }
    }).filter(update => update.before !== update.after)
    if (updates.length) await commitFiles(project, updates)
    return shaderInventory(project)
  })
}
export async function undoShaderChange(project: ProjectInfo): Promise<ShaderInventory> {
  assertShaderProject(project)
  return serial(project.path, async () => {
    const directory = await safeFile(project.path, '.modmind/shader-history')
    const candidates = await Promise.all((await fs.readdir(directory)).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(async name => {
      const committed = await fs.stat(await safeFile(project.path, `.modmind/shader-history/${name}/committed`, true)).catch(() => null)
      return { name, time: committed?.mtimeMs ?? 0 }
    }))
    const latest = candidates.filter(entry => entry.time).sort((a, b) => b.time - a.time)[0]
    if (!latest) throw new Error('没有可撤销的光影修改')
    const changes = JSON.parse(await fs.readFile(await safeFile(project.path, `.modmind/shader-history/${latest.name}/changes.json`), 'utf8')) as Array<{ path: string; before: string; after: string }>
    for (const change of changes) if ((await readShaderFile(project, change.path)).content !== change.after) throw new Error('修改之后文件又有变化，未覆盖后续编辑')
    for (const change of changes) await fs.writeFile(await safeFile(project.path, change.path), change.before)
    await fs.unlink(await safeFile(project.path, `.modmind/shader-history/${latest.name}/committed`))
    return shaderInventory(project)
  })
}
export async function expandedShader(project: ProjectInfo, file: string): Promise<{ source: string; files: string[] }> {
  const visited: string[] = []; let bytes = 0
  const expand = async (file: string, stack: string[]): Promise<string> => {
    if (stack.length > 32 || stack.includes(file)) throw new Error(`include 循环或超过 32 层：${file}`)
    const content = (await readShaderFile(project, file)).content
    if ((bytes += Buffer.byteLength(content)) > 4 * MAX_FILE) throw new Error('include 展开超过 8 MiB')
    visited.push(file)
    const lines = content.split('\n'), expanded: string[] = []
    for (const line of lines) {
      const include = line.match(/^\s*#include\s+"([^"\r\n]+)"\s*(?:\/\/.*)?$/)
      if (!include) { expanded.push(line); continue }
      const target = include[1].startsWith('/') ? `shaders/${include[1].slice(1)}` : path.posix.join(path.posix.dirname(file), include[1])
      if (!target.startsWith('shaders/')) throw new Error(`include 越过 shaders 目录：${include[1]}`)
      expanded.push(await expand(projectSafeInclude(target), [...stack, file]))
    }
    return expanded.join('\n')
  }
  return { source: await expand(file, []), files: [...new Set(visited)] }
}
function projectSafeInclude(value: string): string { return relativePath(value) }
