import path from 'node:path'
import { promises as fs } from 'node:fs'
import sharp, { type Metadata } from 'sharp'

export type SkinProject = { path: string; toolDataDirectory?: string }
export type SkinModel = 'slim' | 'classic'
export type SkinValidationError = { code: string; message: string; xy?: [number, number]; rgba?: number[] }
export type SkinValidation = { passed: boolean; model: SkinModel; width?: number; height?: number; basePixels?: number; outerPixels?: number; errors: SkinValidationError[]; gameRuntimeVerified: false }
export type SkinRecord = { name: string; path: string; model: SkinModel; size: number; updatedAt: string }
export type SkinRead = SkinRecord & { dataUrl: string; validation: SkinValidation }
export type SkinServiceOptions = { project?: () => SkinProject; host?: { requireProject?: () => SkinProject } }

const MAX = 8 * 1024 * 1024

function safeName(value: unknown): string {
  const input = String(value ?? '').trim().replace(/\\/g, '/')
  const leaf = input.split('/').at(-1) ?? ''
  const n = leaf.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120)
  if (!n || n === '.' || n === '..') throw new Error('皮肤名称无效')
  return n.toLowerCase().endsWith('.png') ? n : `${n}.png`
}
function projectPath(project: SkinProject, name: string): { root: string; output: string } {
  const root = path.resolve(project.path, skinRoot(project))
  const output = path.resolve(root, safeName(name))
  const rel = path.relative(root, output)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('皮肤路径不在项目目录内')
  return { root, output }
}
async function assertRealInside(project: SkinProject, directory: string): Promise<void> {
  const realRoot = await fs.realpath(project.path)
  await fs.mkdir(directory, { recursive: true })
  const realDir = await fs.realpath(directory)
  const rel = path.relative(realRoot, realDir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('皮肤目录通过链接指向项目外部')
}
function modelOf(value: unknown): SkinModel { return value === 'classic' ? 'classic' : 'slim' }
function skinRoot(project: SkinProject): string { return path.posix.join(project.toolDataDirectory ?? '.modmind', 'skins') }
function rectPixels(box: readonly number[]): Array<[number, number]> {
  const [x, y, w, h] = box
  const pixels: Array<[number, number]> = []
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) pixels.push([x + dx, y + dy])
  return pixels
}
function uvMasks(model: SkinModel): { base: Set<string>; outer: Set<string> } {
  const arm = model === 'slim' ? 3 : 4
  const parts: Array<[number, number, number, number, number, number, number]> = [
    [0, 0, 8, 8, 8, 32, 0], [16, 16, 8, 4, 12, 0, 16], [40, 16, arm, 4, 12, 0, 16], [32, 48, arm, 4, 12, 16, 0], [0, 16, 4, 4, 12, 0, 16], [16, 48, 4, 4, 12, -16, 0]
  ]
  const base = new Set<string>(), outer = new Set<string>()
  for (const [x, y, w, d, h, dx, dy] of parts) {
    const boxes = [[x + d, y, w, d], [x + d + w, y, w, d], [x, y + d, d, h], [x + d, y + d, w, h], [x + d + w, y + d, d, h], [x + 2 * d + w, y + d, w, h]] as const
    for (const box of boxes) for (const [px, py] of rectPixels(box)) base.add(`${px},${py}`)
    for (const box of boxes) for (const [px, py] of rectPixels([box[0] + dx, box[1] + dy, box[2], box[3]])) outer.add(`${px},${py}`)
  }
  return { base, outer }
}
function decodeDataUrl(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('需要 PNG dataUrl')
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match) throw new Error('只支持 PNG dataUrl')
  const bytes = Buffer.from(match[1], 'base64')
  if (!bytes.length || bytes.length > MAX) throw new Error('PNG 不能为空且不能超过 8 MB')
  return bytes
}

export class SkinService {
  constructor(private readonly options: SkinServiceOptions = {}) {}
  private project(): SkinProject { const project = this.options.project?.() ?? this.options.host?.requireProject?.(); if (!project?.path) throw new Error('当前没有打开项目'); return project }
  private async dir(): Promise<{ project: SkinProject; directory: string }> { const project = this.project(); const directory = path.resolve(project.path, skinRoot(project)); await assertRealInside(project, directory); return { project, directory } }
  async list(): Promise<{ skins: SkinRecord[] }> {
    const { project, directory } = await this.dir(); const relativeRoot = skinRoot(project); const entries = await fs.readdir(directory, { withFileTypes: true }); const skins: SkinRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue
      const file = path.join(directory, entry.name)
      try {
        const metadata = await sharp(file).metadata(); if (metadata.width !== 64 || metadata.height !== 64) continue
        const stat = await fs.stat(file); const sidecar = await fs.readFile(`${file}.json`, 'utf8').then(text => JSON.parse(text) as { model?: unknown }).catch(() => ({ model: undefined } as { model?: unknown }))
        skins.push({ name: entry.name.replace(/\.png$/i, ''), path: path.posix.join(relativeRoot, entry.name), model: modelOf(sidecar.model), size: stat.size, updatedAt: stat.mtime.toISOString() })
      } catch { /* ignore invalid files in the project directory */ }
    }
    skins.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { skins }
  }
  async read(nameOrPath: string): Promise<SkinRead> {
    const { project, directory } = await this.dir(); const { output } = projectPath(project, nameOrPath); const bytes = await fs.readFile(output); if (bytes.length > MAX) throw new Error('皮肤文件过大')
    const sidecar = await fs.readFile(`${output}.json`, 'utf8').then(text => JSON.parse(text) as { model?: unknown }).catch(() => ({ model: undefined } as { model?: unknown })); const model = modelOf(sidecar.model); const validation = await validateBytes(bytes, model); const stat = await fs.stat(output)
    return { name: path.basename(output, '.png'), path: path.posix.join(skinRoot(project), path.relative(directory, output).replaceAll('\\', '/')), model, size: stat.size, updatedAt: stat.mtime.toISOString(), dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, validation }
  }
  async validate(input: { dataUrl?: unknown; model?: unknown }): Promise<SkinValidation> { const model = modelOf(input.model); try { return await validateBytes(decodeDataUrl(input.dataUrl), model) } catch (error) { return { passed: false, model, errors: [{ code: 'input', message: error instanceof Error ? error.message : String(error) }], gameRuntimeVerified: false } } }
  async save(name: string, dataUrl: unknown, model: unknown = 'slim'): Promise<{ path: string; name: string; model: SkinModel; validation: SkinValidation }> {
    const { project } = await this.dir(); const selectedModel = modelOf(model); const bytes = decodeDataUrl(dataUrl); const validation = await validateBytes(bytes, selectedModel); if (!validation.passed) throw new Error(validation.errors.map(error => error.message).join('；'))
    const { output } = projectPath(project, name); await assertRealInside(project, path.dirname(output)); await fs.writeFile(output, bytes); await fs.writeFile(`${output}.json`, JSON.stringify({ model: selectedModel, source: 'ModMind 皮肤工坊', updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    return { name: path.basename(output, '.png'), path: path.posix.join(skinRoot(project), path.basename(output)), model: selectedModel, validation }
  }
  async exportData(dataUrl: unknown, name: string, targetPath: string, model: unknown = 'slim'): Promise<{ path: string; name: string }> {
    const bytes = decodeDataUrl(dataUrl); const validation = await validateBytes(bytes, modelOf(model)); if (!validation.passed) throw new Error(validation.errors.map(error => error.message).join('；'))
    const target = path.resolve(targetPath); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return { path: target, name: path.basename(target) }
  }
}

async function validateBytes(bytes: Buffer, model: SkinModel): Promise<SkinValidation> {
  const errors: SkinValidationError[] = []
  let metadata: Metadata
  try { metadata = await sharp(bytes).metadata() } catch { return { passed: false, model, errors: [{ code: 'format', message: '无法读取 PNG' }], gameRuntimeVerified: false } }
  if (metadata.format !== 'png') errors.push({ code: 'format', message: '文件格式必须为 PNG' })
  if (metadata.width !== 64 || metadata.height !== 64) errors.push({ code: 'size', message: '皮肤尺寸必须为 64×64' })
  if (errors.length) return { passed: false, model, width: metadata.width, height: metadata.height, errors, gameRuntimeVerified: false }
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const { base, outer } = uvMasks(model); const used = new Set([...base, ...outer])
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const index = (y * 64 + x) * info.channels; const rgba = [data[index], data[index + 1], data[index + 2], data[index + 3]]; const key = `${x},${y}`
    if (base.has(key) && rgba[3] !== 255) errors.push({ code: 'base_alpha', message: '基础层必须完全不透明', xy: [x, y], rgba })
    else if (!used.has(key) && rgba[3] !== 0) errors.push({ code: 'unused_uv', message: '无效 UV 区域必须透明', xy: [x, y], rgba })
    else if (outer.has(key) && rgba[3] !== 0 && rgba[3] !== 255) errors.push({ code: 'undeclared_alpha', message: '外层只允许 0 或 255 Alpha', xy: [x, y], rgba })
    if (errors.length >= 256) break
  }
  return { passed: errors.length === 0, model, width: 64, height: 64, basePixels: base.size, outerPixels: outer.size, errors, gameRuntimeVerified: false }
}



