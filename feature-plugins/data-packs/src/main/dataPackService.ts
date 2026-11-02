import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { finished } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import yazl from 'yazl'
import Ajv from 'ajv'
import type { ProjectInfo } from '../../../../src/shared/types'
import { dataPackKind, dataPackObject, dataPackPath, dataPackVersion, newDataPackContent, type DataPackDocument, type DataPackEntry, type DataPackInfo, type DataPackKind, type DataPackValidation } from '../../../../src/shared/dataPack'
import { dataPackStarterMetadata } from '../../../../src/shared/dataPackStarter'
import { assertContentTarget, installContentTransaction } from '../../../../src/main/contentInstallTransaction'
import { withProjectMutation } from '../../../../src/main/projectMutation'
import { archiveEntries, archiveRead } from '../../../../src/main/archiveInspection'

const FILE_LIMIT = 1024 * 1024, PACK_LIMIT = 64 * 1024 * 1024, ENTRY_LIMIT = 10000
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const metadataVersions = new Set(['1.20.1', '1.20.6', '1.21', '1.21.1', '26.3'])
function newMetadata(project: ProjectInfo, name: string): string {
  if (!metadataVersions.has(project.minecraftVersion)) throw new Error('当前版本的数据包元数据尚未适配，可导入已有数据包后编辑与导出')
  return dataPackStarterMetadata(project.minecraftVersion, name)
}
const parents = ['datapacks', 'openloader/data', 'config/openloader/data', 'paxi/datapacks', 'config/paxi/datapacks', 'overrides/datapacks', 'overrides/config/openloader/data', 'overrides/config/paxi/datapacks']
const ajv = new Ajv({ allErrors: true, strict: false })
const reference = { type: 'string', pattern: '^#?(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+(?:/[a-z0-9_.-]+)*$' }
const resultSchema = { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1, maximum: 99 } } }
const tagValidator = ajv.compile({ type: 'object', required: ['values'], properties: { replace: { type: 'boolean' }, values: { type: 'array', items: { anyOf: [reference, { type: 'object', required: ['id'], properties: { id: reference, required: { type: 'boolean' } } }] } } } })
const recipeValidators = new Map<string, ReturnType<typeof ajv.compile>>()
function recipeValidator(version: string, shaped: boolean) {
  const modern = dataPackVersion(version, '1.21.2'), resultId = dataPackVersion(version, '1.20.5') ? 'id' : 'item', key = `${modern}:${resultId}:${shaped}`
  if (!recipeValidators.has(key)) {
    const ingredient = modern ? { anyOf: [reference, { type: 'array', minItems: 1, items: reference }] } : { anyOf: [
      { type: 'object', required: ['item'], properties: { item: reference } }, { type: 'object', required: ['tag'], properties: { tag: reference } }, { type: 'array', minItems: 1, items: { type: 'object' } }
    ] }
    recipeValidators.set(key, ajv.compile({ type: 'object', required: ['type', 'result', ...(shaped ? ['pattern', 'key'] : ['ingredients'])], properties: {
      result: { ...resultSchema, required: [resultId], properties: { count: { type: 'integer', minimum: 1, maximum: dataPackVersion(version, '1.21') ? 99 : 64 }, [resultId]: { ...reference, pattern: reference.pattern.replace('^#?', '^') } } },
      pattern: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 3 } },
      key: { type: 'object', minProperties: 1, propertyNames: { pattern: '^[^ ]$' }, additionalProperties: ingredient },
      ingredients: { type: 'array', minItems: 1, maxItems: 9, items: ingredient }
    } }))
  }
  return recipeValidators.get(key)!
}
export function validateDataPackContent(version: string, file: string, content: string): DataPackValidation {
  const errors: string[] = [], warnings: string[] = []
  if (Buffer.byteLength(content) > FILE_LIMIT) return { valid: false, errors: ['文件超过 1 MiB，请使用文件工作台处理'], warnings }
  if (file.endsWith('.mcfunction')) return { valid: true, errors, warnings: ['命令文件尚未进行命令语义校验，需要在目标游戏版本中验证。'] }
  try {
    const value: unknown = JSON.parse(content.replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value) && !/\/predicates?\//.test(file)) throw new Error('此类数据文件必须是 JSON 对象')
    const obj = dataPackObject(value), kind = dataPackKind(file, value)
    const validator = kind.endsWith('-tag') ? tagValidator : kind.startsWith('recipe') ? recipeValidator(version, kind === 'recipe-shaped') : null
    if (validator && !validator(value)) errors.push(...(validator.errors ?? []).map(error => `${error.instancePath || '/'}：${error.message}`))
    if (kind === 'recipe-shaped' && Array.isArray(obj.pattern) && obj.pattern.every((s: unknown) => typeof s === 'string')) {
      if (new Set(obj.pattern.map((s: string) => s.length)).size !== 1) errors.push('配方每一行的宽度必须相同')
      const used = new Set<string>(obj.pattern.join('').replaceAll(' ', '').split(''))
      if (!used.size) errors.push('配方不能为空')
      for (const symbol of used) if (!(symbol in dataPackObject(obj.key))) errors.push(`配方符号 ${symbol} 没有对应材料`)
      for (const symbol of Object.keys(dataPackObject(obj.key))) if (!used.has(symbol)) errors.push(`配方材料 ${symbol} 没有用于图案`)
    }
    if (/\/recipes?\//.test(file) && !kind.startsWith('recipe')) warnings.push('此配方类型仅检查 JSON 结构，需要目标游戏或加载器进一步校验。')
    if (kind === 'loot-block') {
      if (!Array.isArray(obj.pools)) errors.push('掉落表缺少 pools 数组')
      else for (const pool of obj.pools) {
        if (!Array.isArray(pool?.entries)) errors.push('掉落池缺少 entries 数组')
        if (typeof pool?.rolls === 'number' && (!Number.isFinite(pool.rolls) || pool.rolls < 0)) errors.push('抽取次数必须是非负数')
        for (const entry of Array.isArray(pool?.entries) ? pool.entries : []) if (entry.type === 'minecraft:item' && (typeof entry.name !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(entry.name))) errors.push('掉落物 ID 无效')
      }
      warnings.push('掉落条件、函数及运行时内容仍需游戏验证。')
    }
    if (['json', 'advancement', 'predicate'].includes(kind)) warnings.push('此类型仅检查 JSON 结构，尚未进行完整游戏语义校验。')
    if (!dataPackVersion(version, '1.21') && /\/data\//.test('/' + file) && /\/(?:recipe|loot_table|advancement|function|predicate)\//.test(file)) warnings.push('当前版本使用复数目录，请检查文件路径。')
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  return { valid: !errors.length, errors, warnings }
}
function relative(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('数据包路径无效')
  return value
}
function editable(file: string): string {
  relative(file)
  if (!/^data\/[a-z0-9_.-]+\/[a-z0-9_./-]+\.(?:json|mcfunction)$/.test(file)) throw new Error('只能编辑数据包 data/ 下的 JSON 或函数文件')
  return file
}
async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true).catch(() => false) }
async function saveHistory(project: ProjectInfo, root: string, file: string, content: string): Promise<string> {
  const directory = path.join(project.path, '.modmind/data-pack-history'); await assertContentTarget(project.path, directory); await fs.mkdir(directory, { recursive: true })
  const target = path.join(directory, `${Date.now()}-${randomUUID()}.json`); await fs.writeFile(target, JSON.stringify({ root, path: file, content }))
  const names = (await fs.readdir(directory)).filter(name => /^\d+-[a-f0-9-]+\.(?:json|deleted)$/.test(name)).sort().reverse()
  let bytes = 0
  for (let i = 0; i < names.length; i++) { const candidate = path.join(directory, names[i]); await assertContentTarget(project.path, candidate); bytes += (await fs.stat(candidate)).size; if (i >= 50 || bytes > 32 * 1024 * 1024) await fs.unlink(candidate) }
  return path.relative(project.path, target)
}
export async function dataPackHistory(project: ProjectInfo, root: string) {
  await pack(project, root)
  const directory = path.join(project.path, '.modmind/data-pack-history'); await assertContentTarget(project.path, directory)
  const result: Array<{ id: string; root: string; path: string; at: number; baseline: string | null }> = []
  for (const name of (await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })).filter(name => /^\d+-[a-f0-9-]+\.(?:json|deleted)$/.test(name)).sort().reverse().slice(0, 50)) {
    const file = path.join(directory, name); await assertContentTarget(project.path, file)
    if ((await fs.stat(file)).size > 2 * FILE_LIMIT) continue
    const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.root !== root) continue
    editable(value.path)
    const current = path.join(project.path, root, value.path); await assertContentTarget(project.path, current)
    const baseline = await fs.readFile(current).then(hash).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    result.push({ id: name, root, path: value.path, at: Number(name.split('-')[0]), baseline })
  }
  return { entries: result }
}
export async function restoreDataPackHistory(project: ProjectInfo, root: string, id: string, baseline: string | null): Promise<DataPackDocument> {
  if (!/^\d+-[a-f0-9-]+\.(?:json|deleted)$/.test(id)) throw new Error('恢复记录无效')
  const file = path.join(project.path, '.modmind/data-pack-history', id); await assertContentTarget(project.path, file)
  if ((await fs.stat(file)).size > 2 * FILE_LIMIT) throw new Error('恢复记录过大')
  const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.root !== root) throw new Error('恢复记录不属于当前数据包')
  return writeDataPackDocument(project, { root, path: editable(value.path), content: value.content, baseline })
}
async function localFiles(project: ProjectInfo, root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    await assertContentTarget(project.path, dir)
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
      if (files.length >= ENTRY_LIMIT) throw new Error('数据包超过 10000 个文件，请使用文件工作台处理')
      const rel = `${prefix}${entry.name}`, target = path.join(dir, entry.name)
      await assertContentTarget(project.path, target)
      if (entry.isDirectory()) await walk(target, rel + '/')
      else if (entry.isFile()) files.push(rel)
    }
  }
  await walk(path.join(project.path, root, 'data'), 'data/')
  return files
}
export async function listDataPacks(project: ProjectInfo): Promise<DataPackInfo[]> {
  const result: DataPackInfo[] = []
  if (project.kind !== 'modpack') {
    result.push({ root: 'src/main/resources', name: project.name, source: 'mod', files: (await localFiles(project, 'src/main/resources')).length })
    return result
  }
  for (const parent of parents) {
    const dir = path.join(project.path, parent); await assertContentTarget(project.path, dir)
    if (await exists(path.join(dir, 'pack.mcmeta')) || await exists(path.join(dir, 'data'))) result.push({ root: parent, name: path.posix.basename(parent), source: 'pack', files: (await localFiles(project, parent)).length })
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })) {
      const root = `${parent}/${entry.name}`; await assertContentTarget(project.path, path.join(project.path, root))
      if (entry.isDirectory() && (await exists(path.join(project.path, root, 'pack.mcmeta')) || await exists(path.join(project.path, root, 'data')))) result.push({ root, name: entry.name, source: 'pack', files: (await localFiles(project, root)).length })
      else if (entry.isFile() && entry.name.endsWith('.zip')) result.push({ root, name: entry.name, source: 'pack', archived: true, files: 0 })
    }
  }
  if (await exists(path.join(project.path, 'kubejs/data'))) result.push({ root: 'kubejs', name: 'KubeJS 数据', source: 'pack', files: (await localFiles(project, 'kubejs')).length })
  return result
}
async function pack(project: ProjectInfo, root: string): Promise<DataPackInfo> {
  relative(root)
  if (project.kind !== 'modpack') {
    if (root !== 'src/main/resources') throw new Error('数据包不属于当前模组项目')
    await assertContentTarget(project.path, path.join(project.path, root))
    return { root, name: project.name, source: 'mod', files: 0 }
  }
  if (root !== 'kubejs' && !parents.some(parent => root === parent || root.startsWith(parent + '/') && !root.slice(parent.length + 1).includes('/'))) throw new Error('数据包不属于当前项目')
  const target = path.join(project.path, root); await assertContentTarget(project.path, target)
  const stat = await fs.stat(target).catch(() => null)
  if (!stat || stat.isFile() && !root.endsWith('.zip') || stat.isDirectory() && !await exists(path.join(target, 'data')) && !await exists(path.join(target, 'pack.mcmeta'))) throw new Error('数据包不存在，请刷新列表')
  return { root, name: path.posix.basename(root), source: 'pack', archived: stat.isFile(), files: 0 }
}
async function readBytes(project: ProjectInfo, info: DataPackInfo, file: string): Promise<Buffer> {
  if (info.archived) return archiveRead(path.join(project.path, info.root), file)
  const target = path.join(project.path, info.root, relative(file)); await assertContentTarget(project.path, target)
  if ((await fs.stat(target)).size > FILE_LIMIT) throw new Error('文件超过 1 MiB，请使用文件工作台处理')
  return fs.readFile(target)
}
export async function listDataPackEntries(project: ProjectInfo, root: string): Promise<DataPackEntry[]> {
  const info = await pack(project, root)
  const files = info.archived ? await archiveEntries(path.join(project.path, root)) : await localFiles(project, root)
  if (files.length > ENTRY_LIMIT) throw new Error('数据包超过 10000 个文件')
  return files.filter(file => /^data\/[^/]+\/.+\.(?:json|mcfunction)$/.test(file)).sort().map(file => ({ path: file, kind: dataPackKind(file), id: file.replace(/^data\/([^/]+)\//, '$1:').replace(/\.(?:json|mcfunction)$/, '') }))
}
export async function readDataPackDocument(project: ProjectInfo, root: string, file: string): Promise<DataPackDocument> {
  editable(file)
  const info = await pack(project, root), bytes = await readBytes(project, info, file)
  if (bytes.length > FILE_LIMIT) throw new Error('文件超过 1 MiB')
  const content = bytes.toString('utf8').replace(/^\uFEFF/, '')
  let value: unknown; try { value = JSON.parse(content) } catch { /* A broken file remains editable in source mode. */ }
  return { path: file, id: file.replace(/^data\/([^/]+)\//, '$1:').replace(/\.(?:json|mcfunction)$/, ''), kind: dataPackKind(file, value), content, baseline: hash(bytes), validation: validateDataPackContent(project.minecraftVersion, file, content) }
}
export async function writeDataPackDocument(project: ProjectInfo, input: { root: string; path: string; content: string; baseline: string | null }): Promise<DataPackDocument> {
  return withProjectMutation(project.path, async () => {
    const info = await pack(project, input.root); if (info.archived) throw new Error('ZIP 数据包请先解包编辑，原 ZIP 会保留')
    editable(input.path)
    const validation = validateDataPackContent(project.minecraftVersion, input.path, input.content)
    if (!validation.valid) throw new Error(validation.errors.join('\n'))
    const target = path.join(project.path, input.root, input.path); await assertContentTarget(project.path, target)
    const previous = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if ((previous ? hash(previous) : null) !== input.baseline) throw new Error('文件已被其他操作修改。草稿已保留，请重新打开或另存为新文件')
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (previous) await saveHistory(project, input.root, input.path, previous.toString('utf8'))
    const pending = `${target}.pending-${randomUUID()}`
    try { await fs.writeFile(pending, input.content, { flag: 'wx' }); await fs.rename(pending, target) } finally { await fs.rm(pending, { force: true }).catch(() => undefined) }
    return readDataPackDocument(project, input.root, input.path)
  })
}
export async function removeDataPackDocument(project: ProjectInfo, root: string, file: string, baseline: string): Promise<{ removed: string; recoveryPath: string }> {
  return withProjectMutation(project.path, async () => {
    const info = await pack(project, root); if (info.archived) throw new Error('请先解包编辑')
    const current = await readDataPackDocument(project, root, file)
    if (current.baseline !== baseline) throw new Error('文件已改变，请刷新后重试')
    const recoveryPath = await saveHistory(project, root, file, current.content)
    await fs.unlink(path.join(project.path, root, editable(file)))
    return { removed: file, recoveryPath }
  })
}
export async function createDataPack(project: ProjectInfo, name: string): Promise<DataPackInfo> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name) || name.includes('..')) throw new Error('数据包名称请使用小写字母、数字、下划线或短横线')
  return withProjectMutation(project.path, async () => {
    if (project.kind !== 'modpack') return (await listDataPacks(project))[0]
    const root = `datapacks/${name}`, target = path.join(project.path, root)
    await assertContentTarget(project.path, target)
    if (await exists(target)) throw new Error('同名数据包已存在')
    const metadata = newMetadata(project, name)
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'pack.mcmeta'), metadata); await fs.mkdir(path.join(target, 'data'))
    return { root, name, source: 'pack', files: 0 }
  })
}
export async function createDataPackEntry(project: ProjectInfo, root: string, kind: DataPackKind, namespace: string, id: string): Promise<DataPackDocument> {
  return writeDataPackDocument(project, { root, path: dataPackPath(project.minecraftVersion, namespace, id, kind), content: newDataPackContent(project.minecraftVersion, kind), baseline: null })
}
export async function importDataPack(project: ProjectInfo, source: string): Promise<DataPackInfo> {
  return withProjectMutation(project.path, async () => {
    if (project.kind !== 'modpack') throw new Error('模组项目请导入 data 内容到项目资源目录；整包导入用于整合包项目')
    const files = await archiveEntries(source)
    if (!files.includes('pack.mcmeta') || !files.some(file => file.startsWith('data/'))) throw new Error('请选择根目录含 pack.mcmeta 和 data/ 的数据包 ZIP')
    if (files.length > ENTRY_LIMIT) throw new Error('数据包超过 10000 个文件')
    for (const file of files) relative(file)
    const name = path.basename(source, path.extname(source)).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/\.{2,}/g, '-').slice(0, 50) || 'imported'
    const root = `datapacks/${name}-${randomUUID().slice(0, 8)}`, staging = path.join(project.path, '.modmind', `data-pack-import-${randomUUID()}`)
    await assertContentTarget(project.path, staging); await fs.mkdir(staging, { recursive: true })
    try {
      let total = 0
      for (const file of files) {
        const bytes = await archiveRead(source, file); total += bytes.length
        if (total > PACK_LIMIT) throw new Error('数据包超过 64 MiB，请使用文件工作台处理')
        const target = path.join(staging, file); await assertContentTarget(project.path, target); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
      }
      const metadata = JSON.parse((await fs.readFile(path.join(staging, 'pack.mcmeta'), 'utf8')).replace(/^\uFEFF/, ''))
      if (!Object.hasOwn(dataPackObject(metadata.pack), 'description') || !metadata.pack.pack_format && !metadata.pack.min_format) throw new Error('数据包元数据无效')
      await installContentTransaction(project.path, [{ source: staging, destination: path.join(project.path, root) }], async () => undefined)
      return (await listDataPacks(project)).find(info => info.root === root)!
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined) }
  })
}
export async function validateDataPack(project: ProjectInfo, root: string): Promise<DataPackValidation & { checkedFiles: number }> {
  const errors: string[] = [], warnings: string[] = [], files = await listDataPackEntries(project, root)
  const info = await pack(project, root)
  if (info.source === 'pack' && root !== 'kubejs') {
    try {
      const metadata = JSON.parse((await readBytes(project, info, 'pack.mcmeta')).toString('utf8')).pack
      if (!metadata || !Object.hasOwn(metadata, 'description') || !(Number.isInteger(metadata.pack_format) && metadata.pack_format > 0 || Array.isArray(metadata.min_format) && metadata.min_format.length >= 1 && metadata.min_format.length <= 2 && metadata.min_format.every((n: unknown) => Number.isInteger(n) && Number(n) >= 0))) errors.push('pack.mcmeta 中的数据包格式无效')
      else if (metadataVersions.has(project.minecraftVersion)) { const expected = JSON.parse(newMetadata(project, info.name)).pack; if (metadata.pack_format && metadata.pack_format !== expected.pack_format) warnings.push('数据包声明的格式与当前游戏版本不同，请确认兼容范围。') }
    } catch (error) { errors.push(`pack.mcmeta：${String(error)}`) }
  }
  for (const file of files) {
    try { const doc = await readDataPackDocument(project, root, file.path); errors.push(...doc.validation.errors.map(e => `${file.path}：${e}`)); warnings.push(...doc.validation.warnings.map(w => `${file.path}：${w}`)) }
    catch (error) { errors.push(`${file.path}：${String(error)}`) }
  }
  return { valid: !errors.length, errors, warnings, checkedFiles: files.length }
}
export async function exportDataPack(project: ProjectInfo, root: string): Promise<{ path: string; bytes: number; validation: DataPackValidation }> {
  return withProjectMutation(project.path, async () => {
    const validation = await validateDataPack(project, root); if (!validation.valid) throw new Error(validation.errors.join('\n'))
    const info = await pack(project, root), output = path.join(project.path, 'build/data-packs', `${path.posix.basename(root)}-${randomUUID().slice(0, 8)}.zip`)
    await assertContentTarget(project.path, output); await fs.mkdir(path.dirname(output), { recursive: true })
    const zip = new yazl.ZipFile(), stream = createWriteStream(output), done = finished(stream)
    zip.outputStream.on('error', error => stream.destroy(error)); zip.outputStream.pipe(stream)
    try {
      let total = 0
      const files = info.archived ? await archiveEntries(path.join(project.path, root)) : await localFiles(project, root)
      const metadataPath = path.join(project.path, root, 'pack.mcmeta')
      const metadata = info.archived ? await archiveRead(path.join(project.path, root), 'pack.mcmeta') : info.source !== 'mod' && await exists(metadataPath) ? (await assertContentTarget(project.path, metadataPath), await fs.readFile(metadataPath)) : Buffer.from(newMetadata(project, info.name))
      zip.addBuffer(metadata, 'pack.mcmeta')
      for (const file of files.filter(file => file.startsWith('data/'))) {
        relative(file)
        const bytes = info.archived ? await archiveRead(path.join(project.path, root), file) : await fs.readFile(path.join(project.path, root, file))
        total += bytes.length; if (total > PACK_LIMIT) throw new Error('导出超过 64 MiB，请使用构建与导出')
        zip.addBuffer(bytes, file)
      }
      zip.end(); await done
      return { path: output, bytes: (await fs.stat(output)).size, validation }
    } catch (error) { stream.destroy(); (zip.outputStream as Readable).destroy(); await done.catch(() => undefined); await fs.rm(output, { force: true }).catch(() => undefined); throw error }
  })
}
