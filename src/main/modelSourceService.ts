import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import type { ModelSourceDocument } from '../shared/modelSource'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const safeEntry = (entry: unknown): string => {
  if (typeof entry !== 'string' || !entry || entry.length > 400 || /[\\:\x00-\x1f]/.test(entry) || entry.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('YSM 引用路径无效')
  return entry
}

/** Opens editable YSM sources, never encrypted .ysm payloads. No extraction and no project writes. */
export async function readYsmSource(source: string): Promise<ModelSourceDocument> {
  if (path.extname(source).toLowerCase() === '.ysm') throw new Error('这是加密 .ysm 模型，无法在 Blockbench 中直接打开。请使用作者提供的源文件，或在安装 YSM 的游戏客户端中预览。')
  let root: string, prefix = ''
  if (path.extname(source).toLowerCase() === '.zip') {
    root = source
    const entries = await archiveEntries(root)
    if (entries.length > 20000) throw new Error('YSM 模型包文件数量过多')
    const manifests = entries.filter(entry => /(^|\/)ysm\.json$/.test(entry))
    if (manifests.length !== 1) throw new Error(manifests.length ? 'ZIP 包含多个模型，请解压后选择其中一个模型的 ysm.json' : 'ZIP 中没有可编辑的 ysm.json；加密模型请在游戏中预览')
    prefix = safeEntry(manifests[0]).slice(0, -'ysm.json'.length)
  } else {
    if (path.basename(source).toLowerCase() !== 'ysm.json') throw new Error('请选择 YSM 源模型目录中的 ysm.json 或未加密 ZIP')
    root = path.dirname(source)
  }
  const directory = (await fs.lstat(root)).isDirectory()
  let total = 0
  const read = async (entry: unknown): Promise<Buffer> => {
    const relative = safeEntry(`${prefix}${safeEntry(entry)}`)
    if (directory) {
      let target = root
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('YSM 资源不能使用符号链接')
      for (const segment of relative.split('/')) {
        target = path.join(target, segment)
        if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('YSM 资源不能使用符号链接')
      }
    }
    const bytes = await archiveRead(root, relative)
    total += bytes.length
    if (total > 32 * 1024 * 1024) throw new Error('YSM 源模型超过 32 MiB 预览限制')
    return bytes
  }
  const manifest = record(JSON.parse((await read('ysm.json')).toString('utf8')))
  const player = record(record(manifest.files).player)
  const modelFile = record(player.model).main
  if (typeof modelFile !== 'string') throw new Error('YSM 描述缺少 files.player.model.main；请使用 2.2.1 及以后的源模型结构')
  const model = record(JSON.parse((await read(modelFile)).toString('utf8')))
  const geometries = model['minecraft:geometry']
  if (!Array.isArray(geometries) || geometries.length !== 1 || !Array.isArray(record(geometries[0]).bones)) throw new Error('预览需要包含单个 geometry 的基岩版 1.12+ 模型')
  const bones = record(geometries[0]).bones as unknown[]
  if (bones.length > 2048 || bones.reduce<number>((count, bone) => count + (Array.isArray(record(bone).cubes) ? (record(bone).cubes as unknown[]).length : 0), 0) > 10000) throw new Error('YSM 模型骨骼或方块数量超过预览限制')
  const textureFiles = Array.isArray(player.texture) ? player.texture : []
  if (!textureFiles.length || textureFiles.length > 64) throw new Error('YSM 模型需要 1–64 张材质')
  const preferred = record(manifest.properties).default_texture
  const textureNames = textureFiles.map(value => typeof value === 'string' ? value : record(value).uv).map(safeEntry)
  const textureFile = textureNames.find(file => path.posix.basename(file, '.png') === preferred) ?? textureNames[0]
  if (!textureFile.toLowerCase().endsWith('.png')) throw new Error('YSM 预览贴图必须为 PNG')
  const texture = await sharp(await read(textureFile), { limitInputPixels: 16_777_216 }).png().toBuffer()
  const animations: ModelSourceDocument['animations'] = []
  for (const name of ['main', 'extra']) {
    const entry = record(player.animation)[name]
    if (typeof entry !== 'string') continue
    const content = (await read(entry)).toString('utf8')
    const data = record(JSON.parse(content))
    if (!Object.keys(record(data.animations)).length) throw new Error(`动画文件没有 animations：${entry}`)
    animations.push({ name: entry, content })
  }
  const name = record(manifest.metadata).name
  return {
    name: typeof name === 'string' ? name.slice(0, 128) : path.basename(root, '.zip'), format: 'bedrock', model,
    textures: [{ id: '0', name: path.posix.basename(textureFile), dataUrl: `data:image/png;base64,${texture.toString('base64')}` }], animations
  }
}
