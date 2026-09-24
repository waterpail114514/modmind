import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { projectModelReference, type ProjectModelPreview } from '../shared/projectModels'

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const inside = (root: string, file: string): boolean => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

/** Read-only preview: model and all external textures must belong to this project. */
export async function readProjectModel(projectRoot: string, reference: string): Promise<ProjectModelPreview> {
  const normalized = projectModelReference(reference, true)
  if (!normalized) throw new Error('请选择项目内的 .bbmodel 或 Java 模型 .json 文件')
  const root = path.resolve(projectRoot), realRoot = await fs.realpath(root)
  const target = path.resolve(root, normalized)
  let total = 0
  const read = async (file: string): Promise<Buffer> => {
    if (!inside(root, file) || !inside(realRoot, await fs.realpath(file))) throw new Error('模型和贴图必须位于当前项目内')
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('模型或贴图超过 16 MB 预览限制')
    total += stat.size
    if (total > 48 * 1024 * 1024) throw new Error('模型及贴图超过 48 MB 预览限制')
    return fs.readFile(file)
  }
  const model = record(JSON.parse((await read(target)).toString('utf8')))
  const result: ProjectModelPreview = { path: path.relative(root, target).replaceAll('\\', '/'), name: path.basename(target), warnings: [] }
  let texturePixels = 0
  const texture = async (bytes: Buffer): Promise<string> => {
    const image = sharp(bytes, { limitInputPixels: 16_777_216 })
    const info = await image.metadata()
    texturePixels += (info.width ?? 0) * (info.height ?? 0)
    if (texturePixels > 16_777_216) throw new Error('贴图总像素超过预览限制')
    return `data:image/png;base64,${(await image.png().toBuffer()).toString('base64')}`
  }
  if (/\.bbmodel$/i.test(target)) {
    if (!Array.isArray(model.elements) || !model.elements.length) throw new Error('Blockbench 文件中没有可预览的模型部件')
    if (model.elements.length > 4096 || (model.textures?.length ?? 0) > 64) throw new Error('模型部件或贴图数量超过预览限制')
    let vertices = 0, faces = 0
    for (const raw of model.elements) {
      const element = record(raw)
      vertices += Object.keys(record(element.vertices)).length
      faces += Object.keys(record(element.faces)).length
    }
    if (vertices > 100_000 || faces > 100_000) throw new Error('模型网格超过预览限制')
    const textures: Record<string, string> = Object.create(null)
    for (const [index, raw] of (Array.isArray(model.textures) ? model.textures : []).entries()) {
      const entry = record(raw)
      try {
        const embedded = typeof entry.source === 'string' && /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(entry.source)
        const external = entry.relative_path || entry.path
        const source = embedded ? Buffer.from(embedded[1], 'base64') : typeof external === 'string' && !/^\w+:\/\//.test(external) ? await read(path.resolve(path.dirname(target), external.replaceAll('\\', '/'))) : undefined
        if (!source) throw new Error('贴图未内嵌或没有项目内路径')
        const url = await texture(source)
        for (const id of [String(index), entry.uuid, entry.id].filter((id): id is string => typeof id === 'string')) textures[id] = url
      } catch { result.warnings.push(`贴图 ${String(entry.name || index + 1)} 无法读取，使用素色显示`) }
    }
    result.blockbench = {
      elements: model.elements.map(raw => {
        const item = record(raw)
        return Object.fromEntries(['uuid', 'name', 'type', 'from', 'to', 'origin', 'rotation', 'inflate', 'visibility', 'faces', 'vertices', 'box_uv', 'uv_offset', 'mirror_uv'].filter(key => key in item).map(key => [key, item[key]]))
      }),
      outliner: Array.isArray(model.outliner) ? model.outliner : [],
      boxUv: model.meta?.box_uv === true,
      resolution: { width: Math.max(1, Number(model.resolution?.width) || 16), height: Math.max(1, Number(model.resolution?.height) || 16) }, textures
    }
    if (Array.isArray(model.animations) && model.animations.length) result.warnings.push('显示静态姿态，暂不播放动画')
    if (model.elements.some(raw => !['cube', 'mesh', undefined].includes(record(raw).type))) result.warnings.push('定位器等非几何部件不参与显示')
    return result
  }
  const portable = target.replaceAll('\\', '/'), marker = portable.lastIndexOf('/assets/')
  const assetsRoot = marker >= 0 ? portable.slice(0, marker + 8) : undefined
  const namespace = marker >= 0 ? portable.slice(marker + 8).split('/')[0] : 'minecraft'
  const resourcePath = (value: string, kind: 'models' | 'textures'): string => {
    if (!assetsRoot || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) || value.split('/').includes('..')) throw new Error(`模型引用无法解析：${value}`)
    const [ns, name] = value.includes(':') ? value.split(':') : [namespace, value]
    return path.resolve(assetsRoot, ns, kind, `${name}.${kind === 'models' ? 'json' : 'png'}`)
  }
  const parents = new Set<string>()
  const inherit = async (item: Record<string, any>): Promise<Record<string, any>> => {
    if (!item.parent) return item
    if (typeof item.parent !== 'string' || parents.has(item.parent) || parents.size >= 16) throw new Error('模型父级循环或层级过深')
    parents.add(item.parent)
    const parent = await inherit(record(JSON.parse((await read(resourcePath(item.parent, 'models'))).toString('utf8'))))
    return { ...parent, ...item, elements: item.elements ?? parent.elements, textures: { ...record(parent.textures), ...record(item.textures) } }
  }
  const resolved = await inherit(model)
  if (!Array.isArray(resolved.elements) || !resolved.elements.length || resolved.elements.length > 4096) throw new Error('没有可直接预览的 Java 几何体；请引用保存的 .bbmodel 源模型')
  const definitions = record(resolved.textures), textures: Record<string, string> = Object.create(null)
  if (Object.keys(definitions).length > 64) throw new Error('贴图数量超过预览限制')
  for (const key of Object.keys(definitions)) {
    let value = definitions[key]; const seen = new Set<string>()
    while (typeof value === 'string' && value.startsWith('#') && !seen.has(value)) { seen.add(value); value = definitions[value.slice(1)] }
    try { textures[`#${key}`] = await texture(await read(resourcePath(String(value), 'textures'))) }
    catch { result.warnings.push(`贴图 ${key} 无法读取，使用素色显示`) }
  }
  result.minecraft = { elements: resolved.elements, display: record(resolved.display), textures }
  return result
}
