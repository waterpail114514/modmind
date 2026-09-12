import { ipcMain, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'
import type { ServerCore, ServerProfile } from '../shared/serverPlugin'
import { readServerProfile, saveServerProfile, serverCoreVersions, serverCoreBuilds, importLocalServerCore } from './serverCoreService'
import { importPluginDependencies, inspectPluginProject, listPluginDependencies, searchPluginDependencies, pluginDependencyVersions, downloadPluginDependency } from './serverPluginService'

export function registerServerPluginIpc(options: { project: () => ProjectInfo; window: () => BrowserWindow; busy: () => boolean }): void {
  const project = (root: unknown, mutation = false): ProjectInfo => {
    const current = options.project()
    if (typeof root !== 'string' || path.resolve(root).toLowerCase() !== path.resolve(current.path).toLowerCase() || current.kind !== 'server-plugin') throw new Error('服务端插件项目已切换或不存在')
    if (mutation && options.busy()) throw new Error('请先停止服务端和正在执行的任务')
    return current
  }
  ipcMain.handle('server-plugin:profile', (_, root) => readServerProfile(project(root)))
  ipcMain.handle('server-plugin:search', (_, root, query) => searchPluginDependencies(project(root), String(query ?? '')))
  ipcMain.handle('server-plugin:dependencyVersions', (_, root, id) => pluginDependencyVersions(project(root), id))
  ipcMain.handle('server-plugin:downloadDependency', (_, root, id) => downloadPluginDependency(project(root, true), id))
  ipcMain.handle('server-plugin:saveProfile', (_, root, profile: ServerProfile) => saveServerProfile(project(root, true), profile))
  ipcMain.handle('server-plugin:versions', (_, core: ServerCore) => serverCoreVersions(core))
  ipcMain.handle('server-plugin:builds', (_, core: ServerCore, version: string) => serverCoreBuilds(core, version))
  ipcMain.handle('server-plugin:inspect', (_, root) => inspectPluginProject(project(root)))
  ipcMain.handle('server-plugin:dependencies', (_, root) => listPluginDependencies(project(root)))
  ipcMain.handle('server-plugin:removeDependency', async (_, root, file: string) => {
    const current = project(root, true)
    if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.jar')) throw new Error('插件文件名无效')
    await fs.rm(path.join(current.path, 'server-plugins', file))
  })
  ipcMain.handle('server-plugin:importDependencies', async (_, root) => {
    project(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: '导入运行依赖插件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Plugin JAR', extensions: ['jar'] }] })
    if (result.canceled) return null
    return importPluginDependencies(project(root, true), result.filePaths)
  })
  ipcMain.handle('server-plugin:importCore', async (_, root) => {
    project(root, true)
    const result = await dialog.showOpenDialog(options.window(), { title: '导入本地服务端核心', properties: ['openFile'], filters: [{ name: 'Server JAR', extensions: ['jar'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return importLocalServerCore(project(root, true), result.filePaths[0])
  })
}
