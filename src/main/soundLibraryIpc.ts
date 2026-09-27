import path from 'node:path'
import { promises as fs } from 'node:fs'
import { dialog, type BrowserWindow } from 'electron'
import type { ProjectInfo } from '../shared/types'
import type { SoundEventSave, SoundImportOptions, SoundProcessOptions } from '../shared/soundLibrary'
import { diagnosticHandle } from './diagnosticIpc'
import { SoundLibraryService } from './soundLibraryService'
import { sameProjectPath } from './projectPath'
import type { StudioDraft } from '../shared/soundStudio'

const services = new Map<string, SoundLibraryService>()
export function soundServiceForProject(project: ProjectInfo, minecraftRoot: string, cacheRoot: string): SoundLibraryService {
  const key = path.resolve(project.path) + '|' + project.minecraftVersion
  if (!services.has(key)) services.set(key, new SoundLibraryService({ ...project }, minecraftRoot, cacheRoot))
  while (services.size > 4) { const first = services.keys().next().value!; services.get(first)?.cancel(); services.delete(first) }
  return services.get(key)!
}

export function registerSoundLibraryIpc(options: { project: () => ProjectInfo; window: () => BrowserWindow; minecraftRoot: () => string; cacheRoot: string; busy: () => boolean }): void {
  const service = (root: string, mutation = false): SoundLibraryService => {
    const current = options.project()
    if (typeof root !== 'string' || !sameProjectPath(current.path, root)) throw new Error('项目已经切换，请重新打开声音工作台')
    if (mutation && options.busy()) throw new Error('项目正在执行任务，请等待完成后再保存声音')
    return soundServiceForProject(current, options.minecraftRoot(), options.cacheRoot)
  }
  diagnosticHandle('sounds:list', (_, root, refresh) => service(root).list(Boolean(refresh)))
  diagnosticHandle('sounds:preview', (_, root, id, download) => service(root).readAudio(id, download === true))
  diagnosticHandle('sounds:saveEvent', (_, root, input: SoundEventSave) => service(root, true).saveEvent(input))
  diagnosticHandle('sounds:fetchVanilla', (_, root) => service(root).fetchVanilla())
  diagnosticHandle('sounds:cancel', (_, root) => service(root).cancel())
  diagnosticHandle('sounds:clearCache', (_, root) => service(root).clearCache())
  diagnosticHandle('sounds:undo', (_, root) => service(root, true).undo())
  diagnosticHandle('sounds:process', (_, root, input: SoundProcessOptions) => service(root, true).process(input))
  diagnosticHandle('sounds:saveRendered', (_, root, id, bytes, stream) => service(root, true).saveRendered(id, bytes, stream === true))
  diagnosticHandle('sounds:renderEffect', async (_, root, draft: StudioDraft) => {
    const bytes = await service(root).renderEffect(draft)
    return { dataUrl: 'data:audio/wav;base64,' + bytes.toString('base64'), name: 'effect.wav' }
  })
  diagnosticHandle('sounds:readDraft', (_, root) => service(root).readDraft())
  diagnosticHandle('sounds:saveDraft', (_, root, value) => service(root, true).saveDraft(value))
  diagnosticHandle('sounds:exportMidi', async (_, root, value: Uint8Array) => {
    service(root)
    if (!(value instanceof Uint8Array) || value.length < 14 || value.length > 2 * 1024 * 1024 || Buffer.from(value.subarray(0, 4)).toString() !== 'MThd') throw new Error('MIDI 文件无效或超过 2 MiB')
    const result = await dialog.showSaveDialog(options.window(), { title: '导出 MIDI', defaultPath: 'modmind-music.mid', filters: [{ name: 'MIDI', extensions: ['mid'] }] })
    if (!result.filePath || result.canceled) return null
    await fs.writeFile(result.filePath, value)
    return result.filePath
  })
  diagnosticHandle('sounds:removeFolder', (_, root, id) => service(root, true).removeFolder(id))
  diagnosticHandle('sounds:import', async (_, root, input: SoundImportOptions) => {
    service(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: '导入声音', properties: ['openFile', 'multiSelections'], filters: [{ name: '音频', extensions: ['ogg', 'mp3', 'wav', 'flac', 'm4a'] }] })
    return result.canceled ? null : service(root, true).importFiles(result.filePaths, input)
  })
  diagnosticHandle('sounds:addFolder', async (_, root, minecraft) => {
    service(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: minecraft ? '选择 Minecraft 目录' : '添加个人声音素材目录', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return false
    await service(root, true).addFolder(result.filePaths[0], minecraft === true)
    return true
  })
}
