import { promises as fs } from 'node:fs'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { spawnManaged } from './processTree'
import type {
  AudioImportInput,
  ContentCreateInput,
  ContentCreateResult,
  ContentValidationResult
} from '../shared/production'
import type { ProjectInfo } from '../shared/types'

function compareMinecraft(left: string, right: string): number {
  const parts = (value: string): number[] => (value.startsWith('1.') ? value.slice(2) : value).split('.').map((entry) => Number(entry) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

function resourceId(value: unknown, label = '资源 ID'): string {
  if (typeof value !== 'string') throw new Error(`${label} 无效`)
  const normalized = value.trim().toLowerCase().replace(/^\w+:/, '')
  if (!/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(normalized)) throw new Error(`${label} 只能包含小写字母、数字、点、下划线、短横线和斜杠`)
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error(`${label} 不能包含相对路径段`)
  return normalized
}

function namespaced(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(value.trim())) {
    throw new Error(`资源引用无效：${String(value)}`)
  }
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label}不能为空`)
  return value.map(namespaced)
}

function dataDirectory(project: ProjectInfo, modern: string, legacy: string): string {
  return compareMinecraft(project.minecraftVersion, '1.21') >= 0 ? modern : legacy
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function buildContentFile(project: ProjectInfo, input: ContentCreateInput): { relativePath: string; value: Record<string, unknown> } {
  const id = resourceId(input.id)
  const namespace = project.namespace
  const root = 'src/main/resources'
  if (input.kind === 'data-json' || input.kind === 'asset-json') {
    const value = input.data.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 内容必须是对象')
    const scope = input.kind === 'data-json' ? 'data' : 'assets'
    return { relativePath: `${root}/${scope}/${namespace}/${id}.json`, value: value as Record<string, unknown> }
  }
  if (input.kind === 'language') {
    const locale = typeof input.locale === 'string' && /^[a-z]{2}_[a-z]{2}$/.test(input.locale) ? input.locale : 'en_us'
    const key = typeof input.data.key === 'string' && input.data.key.trim() ? input.data.key.trim() : `${namespace}.${id.replaceAll('/', '.')}`
    const text = typeof input.data.value === 'string' ? input.data.value : ''
    if (!text.trim()) throw new Error('本地化文本不能为空')
    return { relativePath: `${root}/assets/${namespace}/lang/${locale}.json`, value: { [key]: text } }
  }

  if (input.kind === 'recipe-shaped') {
    const pattern = Array.isArray(input.data.pattern) ? input.data.pattern.filter((entry): entry is string => typeof entry === 'string') : []
    if (!pattern.length || pattern.length > 3 || pattern.some((row) => row.length < 1 || row.length > 3) || pattern.some((row) => row.length !== pattern[0].length)) {
      throw new Error('有序配方需要 1-3 行，且每行必须具有相同的 1-3 个字符')
    }
    const keys = input.data.key && typeof input.data.key === 'object' && !Array.isArray(input.data.key)
      ? Object.fromEntries(Object.entries(input.data.key as Record<string, unknown>).map(([symbol, item]) => {
        if (!/^[A-Z0-9]$/.test(symbol)) throw new Error(`配方符号无效：${symbol}`)
        return [symbol, { item: namespaced(item) }]
      }))
      : {}
    const symbols = new Set(pattern.join('').replaceAll(' ', '').split(''))
    for (const symbol of symbols) if (!(symbol in keys)) throw new Error(`图案使用了未定义的配方符号：${symbol}`)
    const resultItem = namespaced(input.data.result)
    const count = Math.min(64, Math.max(1, Number(input.data.count) || 1))
    const result = compareMinecraft(project.minecraftVersion, '1.21') >= 0 ? { id: resultItem, count } : { item: resultItem, count }
    return {
      relativePath: `${root}/data/${namespace}/${dataDirectory(project, 'recipe', 'recipes')}/${id}.json`,
      value: { type: 'minecraft:crafting_shaped', pattern, key: keys, result }
    }
  }

  if (input.kind === 'recipe-shapeless') {
    const ingredients = stringArray(input.data.ingredients, '无序配方材料').map((item) => ({ item }))
    const resultItem = namespaced(input.data.result)
    const count = Math.min(64, Math.max(1, Number(input.data.count) || 1))
    const result = compareMinecraft(project.minecraftVersion, '1.21') >= 0 ? { id: resultItem, count } : { item: resultItem, count }
    return {
      relativePath: `${root}/data/${namespace}/${dataDirectory(project, 'recipe', 'recipes')}/${id}.json`,
      value: { type: 'minecraft:crafting_shapeless', ingredients, result }
    }
  }

  if (input.kind === 'item-tag' || input.kind === 'block-tag') {
    const registry = input.kind === 'item-tag'
      ? dataDirectory(project, 'item', 'items')
      : dataDirectory(project, 'block', 'blocks')
    return {
      relativePath: `${root}/data/${namespace}/tags/${registry}/${id}.json`,
      value: { replace: Boolean(input.data.replace), values: stringArray(input.data.values, '标签内容') }
    }
  }

  if (input.kind === 'loot-block') {
    const item = namespaced(input.data.item)
    const directory = dataDirectory(project, 'loot_table', 'loot_tables')
    return {
      relativePath: `${root}/data/${namespace}/${directory}/blocks/${id}.json`,
      value: {
        type: 'minecraft:block',
        pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: item }], conditions: [{ condition: 'minecraft:survives_explosion' }] }],
        random_sequence: `${namespace}:blocks/${id}`
      }
    }
  }

  const icon = namespaced(input.data.icon)
  const criterionItem = namespaced(input.data.criterionItem)
  const modern = compareMinecraft(project.minecraftVersion, '1.21') >= 0
  return {
    relativePath: `${root}/data/${namespace}/${dataDirectory(project, 'advancement', 'advancements')}/${id}.json`,
    value: {
      parent: typeof input.data.parent === 'string' && input.data.parent ? namespaced(input.data.parent) : 'minecraft:story/root',
      display: {
        icon: modern ? { id: icon } : { item: icon },
        title: { translate: `advancement.${namespace}.${id.replaceAll('/', '.')}.title` },
        description: { translate: `advancement.${namespace}.${id.replaceAll('/', '.')}.description` },
        frame: input.data.frame === 'goal' || input.data.frame === 'challenge' ? input.data.frame : 'task',
        show_toast: true,
        announce_to_chat: true,
        hidden: false
      },
      criteria: { obtain: { trigger: 'minecraft:inventory_changed', conditions: { items: [{ items: modern ? criterionItem : [criterionItem] }] } } }
    }
  }
}

async function mergeJsonObject(target: string, values: Record<string, unknown>): Promise<void> {
  const existing = await fs.readFile(target, 'utf8').then((content) => JSON.parse(content) as unknown).catch(() => ({}))
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`不能合并非对象 JSON：${target}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, json({ ...(existing as Record<string, unknown>), ...values }), 'utf8')
}

async function runFfmpeg(source: string, destination: string): Promise<void> {
  if (!ffmpegPath) throw new Error('当前安装不包含 FFmpeg，无法转换音频')
  const executable = ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  await new Promise<void>((resolve, reject) => {
    const child = spawnManaged(executable, ['-y', '-i', source, '-vn', '-c:a', 'libvorbis', '-q:a', '5', destination], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let errorText = ''
    child.stderr.on('data', (chunk: Buffer) => { errorText = `${errorText}${chunk.toString('utf8')}`.slice(-12_000) })
    child.once('error', reject)
    child.once('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error(`FFmpeg 转换失败（${code ?? 1}）：${errorText.slice(-2_000)}`)))
  })
}

export class ContentService {
  constructor(private readonly getProject: () => ProjectInfo) {}

  async create(input: ContentCreateInput): Promise<ContentCreateResult> {
    const project = this.getProject()
    const built = buildContentFile(project, input)
    const target = path.join(project.path, ...built.relativePath.split('/'))
    if (input.kind === 'language') await mergeJsonObject(target, built.value)
    else {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, json(built.value), 'utf8')
    }
    return { paths: [built.relativePath], summary: `已生成 ${input.kind}：${input.id}`, warnings: [] }
  }

  async importAudio(source: string, input: AudioImportInput): Promise<ContentCreateResult> {
    const project = this.getProject()
    const eventId = resourceId(input.eventId, '声音事件 ID')
    const extension = path.extname(source).toLowerCase()
    if (!['.ogg', '.mp3', '.wav', '.flac', '.m4a'].includes(extension)) throw new Error('请选择 OGG、MP3、WAV、FLAC 或 M4A 音频')
    const relativeAudio = `src/main/resources/assets/${project.namespace}/sounds/${eventId}.ogg`
    const destination = path.join(project.path, ...relativeAudio.split('/'))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    if (extension === '.ogg') await fs.copyFile(source, destination)
    else await runFfmpeg(source, destination)
    const soundsRelative = `src/main/resources/assets/${project.namespace}/sounds.json`
    const soundsPath = path.join(project.path, ...soundsRelative.split('/'))
    await mergeJsonObject(soundsPath, {
      [eventId]: {
        sounds: [{
          name: `${project.namespace}:${eventId}`,
          stream: Boolean(input.stream),
          volume: Math.max(0, Math.min(4, Number(input.volume) || 1)),
          pitch: Math.max(0.01, Math.min(4, Number(input.pitch) || 1))
        }]
      }
    })
    return { paths: [relativeAudio, soundsRelative], summary: `已导入声音 ${project.namespace}:${eventId}`, warnings: [] }
  }

  async validate(): Promise<ContentValidationResult> {
    const project = this.getProject()
    const root = path.join(project.path, 'src', 'main', 'resources')
    const errors: string[] = []
    const warnings: string[] = []
    let checkedFiles = 0
    const jsonValues = new Map<string, Record<string, unknown>>()
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isSymbolicLink()) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(absolute)
        else if (entry.isFile() && checkedFiles < 10_000) {
          checkedFiles += 1
          const relative = path.relative(project.path, absolute).replaceAll('\\', '/')
          if (entry.name.endsWith('.json')) {
            try {
              const value = JSON.parse(await fs.readFile(absolute, 'utf8')) as unknown
              if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`${relative} 必须是 JSON 对象`)
              else jsonValues.set(relative, value as Record<string, unknown>)
            } catch (error) {
              errors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
            }
          } else if (entry.name.endsWith('.ogg')) {
            const header = await fs.readFile(absolute).then((value) => value.subarray(0, 4)).catch(() => Buffer.alloc(0))
            if (header.toString('ascii') !== 'OggS') errors.push(`${relative} 不是有效的 OGG 容器`)
          }
        }
      }
    }
    await visit(root)
    const soundsPath = `src/main/resources/assets/${project.namespace}/sounds.json`
    const sounds = jsonValues.get(soundsPath)
    if (sounds) {
      for (const [event, definition] of Object.entries(sounds)) {
        const entries = definition && typeof definition === 'object' && Array.isArray((definition as { sounds?: unknown }).sounds)
          ? (definition as { sounds: unknown[] }).sounds : []
        if (!entries.length) warnings.push(`声音事件 ${event} 没有声音文件`)
        for (const item of entries) {
          const name = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { name?: unknown }).name : ''
          if (typeof name !== 'string' || name.startsWith('minecraft:')) continue
          const local = name.includes(':') ? name.split(':', 2)[1] : name
          const file = path.join(root, 'assets', project.namespace, 'sounds', `${local}.ogg`)
          if (!(await fs.access(file).then(() => true).catch(() => false))) errors.push(`声音事件 ${event} 缺少 ${local}.ogg`)
        }
      }
    }
    return { success: !errors.length, checkedFiles, errors, warnings }
  }
}
