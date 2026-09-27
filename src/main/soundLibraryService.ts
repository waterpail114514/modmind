import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectInfo } from '../shared/types'
import { parseStudioDraft, renderEffectWav, type StudioDraft } from '../shared/soundStudio'
import type { SoundDefinition, SoundEvent, SoundEventSave, SoundImportOptions, SoundImportResult, SoundLibraryAudio, SoundLibraryItem, SoundLibraryResult, SoundLibrarySource, SoundProcessOptions, SoundSource, SoundVariant } from '../shared/soundLibrary'
import { archiveEntries, archiveRead } from './ftbResourceArchive'
import { AUDIO_LIMIT, audioExtension, digestSound, readSoundBytes, runSoundFfmpeg, safeSoundPath, soundJson, soundResourceId, writeSoundAtomic } from './soundFiles'
import { SoundVanilla } from './soundVanilla'

type Location = { root: string; file: string; archive: boolean; vanilla?: boolean }
type Source = SoundSource & { root: string; archive: boolean; editable: boolean }
type Preferences = { folders: Array<{ path: string; minecraft: boolean }> }
type History = { files: Array<{ relative: string; before: boolean; after: string }> }
const namespaceId = (value: string): string => { if (!/^[a-z0-9_.-]{1,80}$/.test(value) || value === '.' || value === '..') throw new Error('命名空间无效'); return value }
const reference = (name: string, namespace: string): [string, string] => {
  const parts = name.split(':')
  if (parts.length > 2) throw new Error('声音引用无效：' + name)
  return parts.length === 2 ? [namespaceId(parts[0]), soundResourceId(parts[1])] : [namespace, soundResourceId(name)]
}
export function validateSoundDefinition(value: SoundDefinition): void {
  if (!value || !Array.isArray(value.sounds) || value.sounds.length > 512) throw new Error('事件需要一个有效的声音列表（最多 512 项）')
  if (value.subtitle !== undefined && (typeof value.subtitle !== 'string' || value.subtitle.length > 240)) throw new Error('字幕键无效')
  for (const raw of value.sounds) {
    const item = typeof raw === 'string' ? { name: raw } : raw
    if (!item || typeof item.name !== 'string') throw new Error('声音名称不能为空')
    reference(item.name, 'minecraft')
    if (item.type !== undefined && !['file', 'event'].includes(item.type)) throw new Error('声音类型无效')
    for (const [key, min, max] of [['volume', 0, 4], ['pitch', .01, 4], ['weight', 1, 1000000], ['attenuation_distance', 0, 1024]] as const) {
      const number = item[key]
      if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || key === 'weight' && !Number.isInteger(number))) throw new Error(key + ' 超出有效范围')
    }
    for (const key of ['stream', 'preload'] as const) if (item[key] !== undefined && typeof item[key] !== 'boolean') throw new Error(key + ' 必须是开关值')
  }
}
function assertNoCycles(definitions: Record<string, SoundDefinition>, namespace: string): void {
  const visiting = new Set<string>(), complete = new Set<string>()
  const visit = (id: string, depth = 0): void => {
    if (complete.has(id)) return
    if (depth > 128 || visiting.has(id)) throw new Error('声音事件存在循环引用：' + id)
    visiting.add(id)
    for (const raw of definitions[id]?.sounds ?? []) if (typeof raw !== 'string' && raw.type === 'event') {
      const [ns, target] = reference(raw.name, namespace)
      if (ns === namespace && definitions[target]) visit(target, depth + 1)
    }
    visiting.delete(id); complete.add(id)
  }
  for (const id of Object.keys(definitions)) visit(id)
}
const classify = (id: string, name: string): 'music' | 'effect' => /^(music[._]|record[._])/.test(id) || /(^|\/)(music|records)\//.test(name) ? 'music' : 'effect'

export class SoundLibraryService {
  private locations = new Map<string, Location>()
  private eventFiles = new Map<string, { file: string; source: Source }>()
  private cached: { time: number; value: SoundLibraryResult } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private controller: AbortController | null = null
  private vanilla: SoundVanilla | null = null
  constructor(readonly project: ProjectInfo, readonly minecraftRoot: string, readonly cacheRoot: string) {}
  private data(relative: string): Promise<string> { return safeSoundPath(this.project.path, '.modmind/sounds/' + relative) }
  private async preferences(): Promise<Preferences> { return await soundJson<Preferences>(await this.data('sources.json')) ?? { folders: [] } }
  private async vanillaService(): Promise<SoundVanilla> {
    if (!this.vanilla) {
      const folders = (await this.preferences()).folders.filter(item => item.minecraft).map(item => item.path)
      this.vanilla = new SoundVanilla(this.project.minecraftVersion, this.cacheRoot, [this.minecraftRoot, ...folders])
    }
    return this.vanilla
  }
  invalidate(): void { this.cached = null }
  cancel(): void { this.controller?.abort() }
  private async exclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const task = this.tail.catch(() => undefined).then(async () => {
      const controller = new AbortController(); this.controller = controller
      try { return await operation(controller.signal) }
      finally { if (this.controller === controller) this.controller = null; this.invalidate() }
    })
    this.tail = task
    return task
  }
  private async walk(root: string, audioOnly = false): Promise<string[]> {
    const files: string[] = []
    let visited = 0
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > 18) throw new Error('素材目录层级超过 18 层')
      const directory = await safeSoundPath(root, relative)
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++visited > 50000 || files.length >= 12000) throw new Error('素材目录超过扫描上限，请选择更小的目录')
        if (entry.isSymbolicLink()) continue
        const name = relative ? relative + '/' + entry.name : entry.name
        if (entry.isDirectory()) await visit(name, depth + 1)
        else if (entry.isFile() && (audioExtension.test(name) || !audioOnly && /(^|\/)(sounds\.json|lang\/(?:zh_cn|en_us)\.json)$/.test(name))) files.push(name)
      }
    }
    await visit('', 0)
    return files
  }
  private async sources(): Promise<Source[]> {
    const sources: Source[] = []
    for (const relative of ['src/main/resources', 'src/client/resources', ...['common', 'fabric', 'forge', 'neoforge', 'quilt'].map(module => module + '/src/main/resources')]) {
      const root = await safeSoundPath(this.project.path, relative)
      if (await fs.access(path.join(root, 'assets')).then(() => true).catch(() => false)) sources.push({ id: relative, name: '项目 · ' + relative, kind: 'project', root, archive: false, editable: true })
    }
    for (const relative of ['resource-packs', 'resourcepacks', 'mods', 'run/mods', '.modmind/minecraft/mods', '.modmind/minecraft/resourcepacks']) {
      const root = await safeSoundPath(this.project.path, relative)
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
      for (const entry of entries) {
        if (sources.length >= 256) throw new Error('声音来源超过 256 个，请缩小项目资源范围')
        if (entry.isSymbolicLink() || !entry.isDirectory() && !/\.(jar|zip)$/i.test(entry.name)) continue
        const isMod = relative.endsWith('mods')
        sources.push({ id: relative + '/' + entry.name, name: entry.name, kind: isMod ? 'mod' : 'pack', root: await safeSoundPath(root, entry.name), archive: entry.isFile(), editable: false })
      }
    }
    for (const item of (await this.preferences()).folders.filter(item => !item.minecraft)) sources.push({ id: 'library:' + digestSound(item.path).slice(0, 16), name: path.basename(item.path), kind: 'library', root: item.path, archive: false, editable: false })
    return sources
  }
  async list(refresh = false): Promise<SoundLibraryResult> {
    if (!refresh && this.cached && Date.now() - this.cached.time < 30000) return this.cached.value
    const locations = new Map<string, Location>(), eventFiles = new Map<string, { file: string; source: Source }>()
    const result: SoundLibraryResult = { items: [], events: [], sources: [], warnings: [], sourceStatus: { project: '', vanilla: '' } }
    const addDefinitions = async (source: Source, namespace: string, definitions: Record<string, SoundDefinition>, language: Record<string, string>, file: string, files: Set<string>, revision: string): Promise<void> => {
      for (const [id, definition] of Object.entries(definitions)) {
        try { soundResourceId(id); validateSoundDefinition(definition) } catch (error) { result.warnings.push(source.name + ' / ' + id + '：' + String(error)); continue }
        const key = source.id + '|' + namespace + ':' + id
        const event: SoundEvent = { key, id, namespace, sourceId: source.id, source: source.kind, sourceLabel: source.name, subtitle: language[definition.subtitle ?? ''] ?? definition.subtitle ?? '', definition, revision, editable: source.editable }
        result.events.push(event); eventFiles.set(key, { file, source })
        definition.sounds.forEach((raw, index) => {
          const value: SoundVariant = typeof raw === 'string' ? { name: raw } : raw
          if (value.type === 'event') return
          const [ns, name] = reference(value.name, namespace)
          const audioFile = 'assets/' + ns + '/sounds/' + name + '.ogg'
          const audioId = key + '|' + index
          locations.set(audioId, { root: source.root, file: source.kind === 'vanilla' ? 'minecraft/sounds/' + name + '.ogg' : audioFile, archive: source.archive, vanilla: source.kind === 'vanilla' })
          result.items.push({ id: audioId, eventId: namespace + ':' + id, eventKey: key, name: name.split('/').at(-1)!, source: source.kind, sourceId: source.id, sourceLabel: source.name, kind: classify(id, name), path: audioFile, subtitle: event.subtitle, available: files.has(audioFile), stream: Boolean(value.stream), volume: value.volume, pitch: value.pitch, weight: value.weight })
        })
      }
    }
    for (const source of await this.sources()) {
      result.sources.push({ id: source.id, name: source.name, kind: source.kind })
      try {
        const names = source.archive ? await archiveEntries(source.root) : await this.walk(source.kind === 'project' ? await safeSoundPath(source.root, 'assets') : source.root, source.kind === 'library')
        const files = new Set(source.kind === 'project' ? names.map(name => 'assets/' + name) : names)
        const read = (file: string): Promise<Buffer> => source.archive ? archiveRead(source.root, file) : readSoundBytes(source.root, file)
        for (const file of files) {
          const match = /^assets\/([a-z0-9_.-]+)\/sounds\.json$/.exec(file)
          if (!match) continue
          const bytes = await read(file)
          const language = await read('assets/' + match[1] + '/lang/zh_cn.json').then(data => JSON.parse(data.toString())).catch(() => ({}))
          await addDefinitions(source, match[1], JSON.parse(bytes.toString()), language, file, files, digestSound(bytes))
        }
        const referenced = new Set([...locations.values()].filter(item => item.root === source.root).map(item => item.file))
        for (const file of files) if (audioExtension.test(file) && !referenced.has(file)) {
          const id = source.id + '|file|' + file
          locations.set(id, { root: source.root, file, archive: source.archive })
          result.items.push({ id, eventId: '', name: path.basename(file), source: source.kind, sourceId: source.id, sourceLabel: source.name, kind: /(^|\/)(music|records)\//.test(file) ? 'music' : source.kind === 'library' ? 'unknown' : 'effect', path: file, available: true, stream: false })
        }
      } catch (error) { result.sources.at(-1)!.error = String(error); result.warnings.push(source.name + '：' + String(error)) }
    }
    const vanilla = await this.vanillaService()
    if (refresh) vanilla.refreshLocal()
    const vanillaSource: Source = { id: 'vanilla', name: 'Minecraft ' + this.project.minecraftVersion, kind: 'vanilla', root: '', archive: false, editable: false }
    result.sources.push(vanillaSource)
    try {
      const catalog = await vanilla.catalog()
      if (catalog) {
        await addDefinitions(vanillaSource, 'minecraft', catalog.definitions, catalog.language, 'sounds.json', new Set(), '')
        result.sourceStatus.vanilla = vanillaSource.name
        await vanilla.localIndex()
        const vanillaItems = result.items.filter(item => item.source === 'vanilla')
        const names = [...new Set(vanillaItems.map(item => locations.get(item.id)!.file))]
        const availability = new Map<string, boolean>()
        for (let offset = 0; offset < names.length; offset += 32) {
          await Promise.all(names.slice(offset, offset + 32).map(async name => {
            availability.set(name, await vanilla.hasLocalAudio(name))
          }))
        }
        for (const item of vanillaItems) {
          const name = locations.get(item.id)!.file
          item.size = (await vanilla.info(name))?.size
          item.available = availability.get(name) ?? false
        }
      } else { result.sourceStatus.vanilla = '此版本的原版目录尚未获取'; result.sources.at(-1)!.error = result.sourceStatus.vanilla }
    } catch (error) { result.sourceStatus.vanilla = String(error); result.warnings.push('原版目录：' + String(error)) }
    result.sourceStatus.project = String(result.events.filter(event => event.editable).length) + ' 个项目事件'
    this.locations = locations; this.eventFiles = eventFiles
    this.cached = { time: Date.now(), value: result }
    return result
  }
  private async resolveAudio(id: string, download: boolean, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string }> {
    await this.list()
    const location = this.locations.get(id)
    if (!location) throw new Error('声音已变化，请刷新声音库')
    const bytes = location.vanilla ? await (await this.vanillaService()).bytes(location.file, download, signal) : location.archive ? await archiveRead(location.root, location.file) : await readSoundBytes(location.root, location.file)
    if (bytes.length > AUDIO_LIMIT) throw new Error('声音文件超过 64 MiB')
    return { bytes, name: location.file }
  }
  async readAudio(id: string, download = false): Promise<SoundLibraryAudio> {
    const operation = async (signal?: AbortSignal): Promise<SoundLibraryAudio> => {
      const { bytes, name } = await this.resolveAudio(id, download, signal)
      const mime = name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.flac') ? 'audio/flac' : name.endsWith('.m4a') ? 'audio/mp4' : 'audio/ogg'
      return { dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64'), name }
    }
    return download ? this.exclusive(operation) : operation()
  }
  async addFolder(folder: string, minecraft = false): Promise<void> {
    await safeSoundPath(folder, '')
    if (minecraft && !(await fs.stat(path.join(folder, 'assets')).catch(() => null))?.isDirectory()) throw new Error('请选择包含 assets 文件夹的 Minecraft 目录')
    const preferences = await this.preferences()
    if (preferences.folders.length >= 12) throw new Error('最多添加 12 个素材或 Minecraft 目录')
    if (!preferences.folders.some(item => item.path === folder)) preferences.folders.push({ path: folder, minecraft })
    await writeSoundAtomic(await this.data('sources.json'), JSON.stringify(preferences)); this.vanilla = null; this.invalidate()
  }
  async removeFolder(id: string): Promise<void> {
    const preferences = await this.preferences()
    preferences.folders = preferences.folders.filter(item => 'library:' + digestSound(item.path).slice(0, 16) !== id)
    await writeSoundAtomic(await this.data('sources.json'), JSON.stringify(preferences)); this.vanilla = null; this.invalidate()
  }
  async fetchVanilla(): Promise<void> { await this.exclusive(async signal => (await this.vanillaService()).fetchCatalog(signal)) }
  async clearCache(): Promise<void> { await (await this.vanillaService()).prune(true); this.invalidate() }
  private async commit(changes: Array<{ file: string; bytes: Buffer | string }>): Promise<void> {
    const historyRoot = await this.data('history/' + Date.now() + '-' + randomUUID())
    await fs.mkdir(historyRoot, { recursive: true })
    const history: History = { files: [] }
    for (const [index, change] of changes.entries()) {
      const relative = path.relative(this.project.path, change.file).replaceAll('\\', '/')
      await safeSoundPath(this.project.path, relative)
      const old = await fs.readFile(change.file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (old) await fs.writeFile(path.join(historyRoot, String(index)), old)
      history.files.push({ relative, before: old !== null, after: digestSound(change.bytes) })
    }
    await writeSoundAtomic(path.join(historyRoot, 'history.json'), JSON.stringify(history))
    try { for (const change of changes) await writeSoundAtomic(change.file, change.bytes) }
    catch (error) {
      for (const [index, entry] of history.files.entries()) {
        const target = await safeSoundPath(this.project.path, entry.relative)
        if (entry.before) await writeSoundAtomic(target, await fs.readFile(path.join(historyRoot, String(index))))
        else await fs.rm(target, { force: true })
      }
      await fs.rm(historyRoot, { recursive: true, force: true }); throw error
    }
    const root = await this.data('history')
    const names = (await fs.readdir(root)).filter(name => /^\d+-[a-f0-9-]+$/.test(name)).sort().reverse()
    for (const name of names.slice(10)) await fs.rm(await safeSoundPath(root, name), { recursive: true, force: true })
  }
  async undo(): Promise<void> {
    await this.exclusive(async () => {
      const root = await this.data('history')
      const name = (await fs.readdir(root).catch(() => [])).filter(name => /^\d+-[a-f0-9-]+$/.test(name)).sort().at(-1)
      if (!name) throw new Error('没有可撤销的声音修改')
      const directory = await safeSoundPath(root, name), history = await soundJson<History>(path.join(directory, 'history.json'))
      if (!history) throw new Error('声音历史记录损坏')
      for (const file of history.files) {
        const bytes = await readSoundBytes(this.project.path, file.relative)
        if (digestSound(bytes) !== file.after) throw new Error('文件已被其他操作修改，不能覆盖：' + file.relative)
      }
      for (const [index, file] of history.files.entries()) {
        const target = await safeSoundPath(this.project.path, file.relative)
        if (file.before) await writeSoundAtomic(target, await readSoundBytes(directory, String(index)))
        else await fs.rm(target, { force: true })
      }
      await fs.rm(directory, { recursive: true, force: true })
    })
  }
  async saveEvent(input: SoundEventSave): Promise<void> {
    await this.exclusive(async () => {
      soundResourceId(input.id); namespaceId(input.namespace)
      validateSoundDefinition(input.definition)
      const catalog = await this.list(true), existing = catalog.events.find(event => event.key === input.key)
      if (input.key && (!existing || !existing.editable)) throw new Error('此声音事件为只读，请创建项目副本')
      if (existing && input.namespace !== existing.namespace) throw new Error('已存在事件不能直接改变命名空间；请复制为新事件')
      const location = existing ? this.eventFiles.get(existing.key)! : null
      const file = location ? await safeSoundPath(location.source.root, location.file) : await safeSoundPath(this.project.path, 'src/main/resources/assets/' + input.namespace + '/sounds.json')
      const old = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (existing && digestSound(old ?? '') !== input.revision) throw new Error('声音文件已被其他操作修改；草稿已保留，请刷新后重新打开')
      const definitions: Record<string, SoundDefinition> = old ? JSON.parse(old.toString()) : {}
      if (!existing || input.id !== existing.id) {
        if (Object.hasOwn(definitions, input.id)) throw new Error('声音事件已存在，请打开已有事件或使用其他 ID')
      }
      if (existing && (input.remove || input.id !== existing.id)) {
        for (const event of catalog.events) if (event.key !== existing.key && event.definition.sounds.some(raw => typeof raw !== 'string' && raw.type === 'event' && reference(raw.name, event.namespace).join(':') === existing.namespace + ':' + existing.id)) throw new Error('事件被 ' + event.id + ' 引用，请先修改引用')
        delete definitions[existing.id]
      }
      if (!input.remove) definitions[input.id] = input.definition
      assertNoCycles(definitions, input.namespace)
      await this.commit([{ file, bytes: JSON.stringify(definitions, null, 2) + '\n' }])
    })
  }
  private async importOne(source: string, eventId: string, stream: boolean, signal: AbortSignal, filters: string[] = [], end?: number): Promise<void> {
    soundResourceId(eventId)
    const namespace = namespaceId(this.project.namespace)
    const root = await safeSoundPath(this.project.path, 'src/main/resources/assets/' + namespace)
    const definitionFile = await safeSoundPath(root, 'sounds.json')
    const definitions = await soundJson<Record<string, SoundDefinition>>(definitionFile) ?? {}
    if (typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('sounds.json 必须是对象')
    const definition = definitions[eventId] ?? { sounds: [] }
    validateSoundDefinition(definition)
    let name = eventId, suffix = 1
    while (await fs.access(await safeSoundPath(root, 'sounds/' + name + '.ogg')).then(() => true).catch(() => false)) name = eventId + '_' + ++suffix
    const output = await this.data('tmp/' + randomUUID() + '.ogg')
    await fs.mkdir(path.dirname(output), { recursive: true })
    try {
      await runSoundFfmpeg(['-y', '-i', source, '-vn', ...(end !== undefined ? ['-t', String(end)] : []), ...(filters.length ? ['-af', filters.join(',')] : []), '-c:a', 'libvorbis', '-q:a', '5', output], signal)
      signal.throwIfAborted()
      const bytes = await readSoundBytes(path.dirname(output), path.basename(output))
      definitions[eventId] = { ...definition, sounds: [...definition.sounds, { name: namespace + ':' + name, stream }] }
      await this.commit([{ file: await safeSoundPath(root, 'sounds/' + name + '.ogg'), bytes }, { file: definitionFile, bytes: JSON.stringify(definitions, null, 2) + '\n' }])
    } finally { await fs.rm(output, { force: true }) }
  }
  async importFiles(files: string[], input: SoundImportOptions): Promise<SoundImportResult> {
    if (files.length > 100) throw new Error('一次最多导入 100 个声音')
    if (input.group) soundResourceId(input.eventId ?? '')
    return this.exclusive(async signal => {
      const result: SoundImportResult = { imported: 0, errors: [] }
      for (const source of files) {
        if (signal.aborted) { result.errors.push('已取消，已完成的文件保留，可撤销'); break }
        try {
          if (!audioExtension.test(source) || (await fs.stat(source)).size > AUDIO_LIMIT) throw new Error('文件格式不支持或超过 64 MiB')
          const name = path.basename(source, path.extname(source)).toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^\.+$/, '') || 'sound'
          await this.importOne(source, input.group ? input.eventId! : name, input.stream, signal); result.imported++
        } catch (error) { result.errors.push(path.basename(source) + '：' + String(error)) }
      }
      return result
    })
  }
  async process(input: SoundProcessOptions): Promise<void> {
    for (const value of [input.start, input.fadeIn, input.fadeOut, input.gain, ...(input.end === undefined ? [] : [input.end])]) if (!Number.isFinite(value) || value < 0 || value > 3600) throw new Error('声音处理参数无效')
    if (input.end !== undefined && input.end <= input.start || input.gain > 4) throw new Error('结束时间必须晚于开始时间，音量不得超过 4')
    await this.exclusive(async signal => {
      const source = await this.resolveAudio(input.id, false, signal)
      const temporary = await this.data('tmp/' + randomUUID() + path.extname(source.name))
      await fs.mkdir(path.dirname(temporary), { recursive: true }); await fs.writeFile(temporary, source.bytes)
      const filters = ['atrim=start=' + input.start + (input.end === undefined ? '' : ':end=' + input.end), 'asetpts=PTS-STARTPTS', 'volume=' + input.gain]
      if (input.reverse) filters.push('areverse')
      if (input.mono) filters.push('aformat=channel_layouts=mono')
      if (input.fadeIn) filters.push('afade=t=in:st=0:d=' + input.fadeIn)
      if (input.fadeOut) { if (input.end === undefined) throw new Error('设置淡出时需要指定结束时间'); filters.push('afade=t=out:st=' + Math.max(0, input.end - input.start - input.fadeOut) + ':d=' + input.fadeOut) }
      try { await this.importOne(temporary, input.eventId, input.end !== undefined && input.end - input.start > 30, signal, filters) }
      finally { await fs.rm(temporary, { force: true }) }
    })
  }
  async saveRendered(eventId: string, bytes: Uint8Array, stream: boolean): Promise<void> {
    const buffer = Buffer.from(bytes)
    if (buffer.length < 44 || buffer.length > AUDIO_LIMIT || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('制作结果不是有效的 WAV 音频')
    await this.exclusive(async signal => {
      const temporary = await this.data('tmp/' + randomUUID() + '.wav')
      await fs.mkdir(path.dirname(temporary), { recursive: true }); await fs.writeFile(temporary, buffer)
      try { await this.importOne(temporary, eventId, stream, signal) }
      finally { await fs.rm(temporary, { force: true }) }
    })
  }
  async renderEffect(input: StudioDraft): Promise<Buffer> {
    const draft = parseStudioDraft(JSON.stringify(input))
    if (draft.mode !== 'effect') throw new Error('当前工程不是音效')
    return this.exclusive(async signal => {
      const synthesized = Buffer.from(await renderEffectWav(draft.effect.settings))
      if (draft.effect.layers.length === 0 && draft.gain === 1) return synthesized
      const temporary = await this.data('tmp/render-' + randomUUID())
      await fs.mkdir(temporary, { recursive: true })
      try {
        const sources: Array<{ file: string; gain: number; offset: number; rate: number }> = []
        const base = path.join(temporary, 'base.wav')
        await fs.writeFile(base, synthesized)
        sources.push({ file: base, gain: draft.gain, offset: 0, rate: 1 })
        for (const [index, layer] of draft.effect.layers.entries()) {
          signal.throwIfAborted()
          const source = await this.resolveAudio(layer.sourceId, false, signal)
          const file = path.join(temporary, 'layer-' + index + path.extname(source.name))
          await fs.writeFile(file, source.bytes)
          sources.push({ file, gain: layer.gain * draft.gain, offset: layer.offset, rate: layer.rate })
        }
        const filters = sources.map((source, index) => {
          const speed = `aresample=44100,asetrate=${Math.round(44100 * source.rate)},aresample=44100`
          const delay = Math.round(source.offset * 1000)
          return `[${index}:a]${speed},aformat=channel_layouts=stereo,adelay=${delay}|${delay},volume=${source.gain}[s${index}]`
        })
        const labels = sources.map((_, index) => `[s${index}]`).join('')
        filters.push(`${labels}amix=inputs=${sources.length}:duration=longest:normalize=0,alimiter=limit=0.95[out]`)
        const output = path.join(temporary, 'mixed.wav')
        await runSoundFfmpeg(['-y', ...sources.flatMap(source => ['-i', source.file]), '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '44100', output], signal)
        return await readSoundBytes(temporary, 'mixed.wav')
      } finally { await fs.rm(temporary, { recursive: true, force: true }) }
    })
  }
  async readDraft(): Promise<string | null> { return fs.readFile(await this.data('studio.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error }) }
  async saveDraft(value: string): Promise<void> {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error('制作工程超过 2 MiB')
    JSON.parse(value)
    await writeSoundAtomic(await this.data('studio.json'), value)
  }
}
