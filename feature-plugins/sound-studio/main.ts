import path from 'node:path'
import { app } from 'electron'
import type { NativeFeatureHost } from '../../src/main/index'
import type { ProjectInfo } from '../../src/shared/types'
import { nativeActions } from '../sdk/native'
import { registerSoundLibraryIpc, soundServiceForProject } from './src/main/soundLibraryIpc'
import { createSoundMcpHandlers } from './src/main/soundMcpService'
import { renderMusicInWindow } from './src/main/soundRenderBridge'

export function activate(options: { host: NativeFeatureHost }) {
  const host = options.host
  const { actions, handle } = nativeActions(host)
  registerSoundLibraryIpc({ project: host.requireProject, window: () => host.mainWindow!,
    busy: () => Boolean(host.runsForProject(host.requireProject().path).length),
    minecraftRoot: () => host.requireMinecraftRuntime().managedMinecraftDirectory(),
    cacheRoot: path.join(app.getPath('userData'), 'sound-library'), handle })
  const mcp = (project: ProjectInfo, signal?: AbortSignal) => createSoundMcpHandlers({
    service: soundServiceForProject(project, path.join(app.getPath('userData'), 'minecraft-runtime', 'game'), path.join(app.getPath('userData'), 'sound-library')),
    renderMusic: draft => { if (!host.mainWindow) throw new Error('工作台窗口不可用，无法渲染音乐'); return renderMusicInWindow(host.mainWindow, draft, signal) },
    assertCurrent: () => { signal?.throwIfAborted(); if (!host.currentProject || host.currentProject.path !== project.path) throw new Error('项目已经切换，请重新打开当前项目的工作台') }
  })
  actions.read = (input, context) => mcp(host.requireProject(), (context as { signal?: AbortSignal }).signal).read(input)
  actions.create = (input, context) => mcp(host.requireProject(), (context as { signal?: AbortSignal }).signal).create(input)
  return { actions, soundServiceForProject, createSoundMcpHandlers, renderMusicInWindow, mcp }
}
