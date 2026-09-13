import { ipcMain, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { createResourcePack, deployResourcePack, importResourcePack, importResourcePackAssets, listResourcePacks, previewResourcePackModel, readResourcePackFile, removeResourcePackFile, resourcePackArchive, resourcePackModelDocument, validateResourcePack, writeResourcePackFile } from './resourcePackService'
import type { BlockbenchBridge } from './blockbenchBridge'
import type { ResourceModelTarget } from '../shared/modelSource'
import { makeResourcePackEditable, resourcePackThumbnail } from './resourcePackService'

export function registerResourcePackIpc(options: { project: () => ProjectInfo; window: () => BrowserWindow; busy: () => boolean; blockbench: () => BlockbenchBridge }): void {
  const project = (root: unknown, mutation = false): ProjectInfo => {
    const current = options.project()
    if (typeof root !== 'string' || path.resolve(root).toLowerCase() !== path.resolve(current.path).toLowerCase()) throw new Error('项目已经切换，请重新打开资源包')
    if (mutation && options.busy()) throw new Error('项目正在执行任务，请等待完成或取消后再修改资源包')
    return current
  }
  ipcMain.handle('resource-packs:list', (_, root) => listResourcePacks(project(root)))
  ipcMain.handle('resource-packs:makeEditable', (_, root, id) => makeResourcePackEditable(project(root, true), id))
  ipcMain.handle('resource-packs:create', (_, root, input) => createResourcePack(project(root, true), input))
  ipcMain.handle('resource-packs:read', (_, root, id, file) => readResourcePackFile(project(root), id, file))
  ipcMain.handle('resource-packs:previewModel', (_, root, id, file) => previewResourcePackModel(project(root), id, file))
  ipcMain.handle('resource-packs:thumbnail', (_, root, id, file) => resourcePackThumbnail(project(root), id, file))
  ipcMain.handle('resource-packs:openModel', async (_, root, id, file) => {
    const current = project(root, true)
    const { document, baseline } = await resourcePackModelDocument(current, id, file)
    project(root, true)
    const projectUuid = await options.blockbench().loadSourceDocument(document)
    return { projectPath: current.path, id, file, baseline, projectUuid } satisfies ResourceModelTarget
  })
  ipcMain.handle('resource-packs:saveModel', async (_, target: ResourceModelTarget) => {
    if (!target || typeof target.file !== 'string' || typeof target.projectUuid !== 'string') throw new Error('模型保存目标无效')
    const current = project(target.projectPath, true)
    const original = await readResourcePackFile(current, target.id, target.file)
    if (original.baseline !== target.baseline) throw new Error('模型文件已被其他操作修改，请重新打开后保存')
    const projectFile = target.file.endsWith('.bbmodel')
    if (!projectFile && !/^assets\/[^/]+\/models\/.+\.json$/.test(target.file)) throw new Error('模型保存路径无效')
    const compiled = await options.blockbench().serializeSourceDocument(target.projectUuid, projectFile)
    // Blockbench exports geometry; keep resource-pack metadata such as overrides and custom fields.
    const content = projectFile ? compiled : JSON.stringify({ ...JSON.parse(original.text!), ...JSON.parse(compiled) }, null, 2)
    project(target.projectPath, true)
    await writeResourcePackFile(current, target.id, target.file, content, target.baseline)
    return (await readResourcePackFile(current, target.id, target.file)).baseline
  })
  ipcMain.handle('resource-packs:write', (_, root, id, file, content, baseline) => writeResourcePackFile(project(root, true), id, file, content, baseline))
  ipcMain.handle('resource-packs:removeFile', (_, root, id, file, baseline) => removeResourcePackFile(project(root, true), id, file, baseline))
  ipcMain.handle('resource-packs:validate', (_, root, id) => validateResourcePack(project(root), id))
  ipcMain.handle('resource-packs:deploy', (_, root, id) => deployResourcePack(project(root, true), id))
  ipcMain.handle('resource-packs:import', async (_, root, directory) => {
    project(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: '导入资源包', properties: directory ? ['openDirectory'] : ['openFile'], ...(directory ? {} : { filters: [{ name: 'Resource pack', extensions: ['zip'] }] }) })
    return result.canceled || !result.filePaths[0] ? null : importResourcePack(project(root, true), result.filePaths[0])
  })
  ipcMain.handle('resource-packs:importAssets', async (_, root, id, directory) => {
    project(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: '导入资源文件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Resource files', extensions: ['png', 'json', 'mcmeta', 'ogg', 'ttf', 'otf', 'properties', 'bbmodel', 'fsh', 'vsh', 'glsl'] }] })
    return result.canceled ? null : importResourcePackAssets(project(root, true), id, directory, result.filePaths)
  })
  ipcMain.handle('resource-packs:export', async (_, root, id) => {
    project(root)
    const result = await dialog.showSaveDialog(options.window(), { title: '导出资源包', defaultPath: `${id}.zip`, filters: [{ name: 'Resource pack ZIP', extensions: ['zip'] }] })
    if (result.canceled || !result.filePath) return null
    const bytes = await resourcePackArchive(project(root), id)
    await fs.writeFile(result.filePath, bytes)
    return result.filePath
  })
}
