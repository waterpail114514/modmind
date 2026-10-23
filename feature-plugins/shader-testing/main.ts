import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { detectInstalledJavaHomes } from '../../src/main/buildRuntime'
import type { DetectedJavaHome } from '../../src/shared/types'
import type { NativeFeatureHost } from '../../src/main/index'
import { shaderFeatureContext } from '../shader-shared/src/main/shaderFeature'
import { shaderInventory } from '../shader-shared/src/main/shaderSourceService'
import { bindShaderInstance, deployShader, shaderTestState } from '../shader-shared/src/main/shaderTestingService'
import { readRuntimeBinding, saveRuntimeBinding } from '../shader-shared/src/main/shaderRuntimeEnvironment'
import { ShaderSessionService, type ShaderSessionDependencies } from '../shader-shared/src/main/shaderSessionService'
import { safeFile } from '../shader-shared/src/main/shaderFiles'

export function activate(options: { host: NativeFeatureHost; stateDirectory?: string; sessionDependencies?: Pick<ShaderSessionDependencies, 'javaHomes' | 'launch'> }) {
  const host = options.host
  const { project, mutable, actions } = shaderFeatureContext(host)
  const bindingDirectory = path.join(options.stateDirectory ?? app.getPath('userData'), 'shader-testing', 'bindings')
  let javaCache: { time: number; homes: DetectedJavaHome[] } | undefined
  const session = new ShaderSessionService({ currentProject: () => host.requireProject(), bindingDirectory, javaHomes: async () => {
    if (javaCache && Date.now() - javaCache.time < 60000) return javaCache.homes
    const preferred = typeof host.readSettings === 'function' ? (await host.readSettings()).javaPreferences.game : ''
    const homes = await detectInstalledJavaHomes(preferred && preferred !== 'auto' ? [preferred] : [])
    const preferredHome = preferred && preferred !== 'auto' ? await fs.realpath(preferred).catch(() => path.resolve(preferred)) : ''
    const selected = preferredHome ? homes.filter(home => path.resolve(home.home).toLowerCase() === preferredHome.toLowerCase()) : homes
    javaCache = { time: Date.now(), homes: selected }; return selected
  }, ...options.sessionDependencies })
  return {
    dispose: () => session.dispose(),
    projectChanged: (path: string | null) => session.projectChanged(path),
    stopForSignal: (signal: AbortSignal) => session.stopForSignal(signal),
    isBusy: () => session.isBusy(),
    actions: actions({
      query: async (input, context) => {
        const current = project(context)
        if (input.operation === 'inventory') return shaderInventory(current)
        if (input.operation === 'capabilities') { javaCache = undefined; return session.capabilities(current) }
        if (input.operation === 'session-state') return session.state(current, input.sessionId as string | undefined)
        if (input.operation === 'observe') return session.observe(current, String(input.sessionId), false, context.signal)
        if (input.operation === 'test-state') {
          const state = await shaderTestState(current)
          return context.windowId && !context.surface ? state : { ...state, screenshots: state.screenshots.map(image => ({ name: image.name })), captures: state.screenshots }
        }
        throw new Error('不支持的游戏验证查询')
      },
      test: async (input, context) => {
        const current = mutable(context)
        if (['bind', 'bind-runtime'].includes(String(input.operation)) && session.isBusy()) throw new Error('请先停止测试会话，再更换实例或运行库')
        if (input.operation === 'deploy') return deployShader(current)
        if (input.operation === 'reveal') {
          const state = await shaderTestState(current)
          if (!state.instancePath) throw new Error('请先选择游戏实例')
          const error = await shell.openPath(state.instancePath)
          if (error) throw new Error(`无法打开游戏实例：${error}`)
          return { status: 'opened', instancePath: state.instancePath }
        }
        if (input.operation === 'bind') {
          if (!context.windowId || context.surface) throw new Error('请在光影测试页面选择实例；MCP 只能向已选择的实例部署')
          const window = host.mainWindow
          if (!window || window.isDestroyed()) throw new Error('请先打开光影游戏验证页面')
          const selected = await dialog.showOpenDialog(window, { title: '选择已有 Iris 实例的游戏目录', properties: ['openDirectory'] })
          if (selected.canceled || !selected.filePaths[0]) return null
          if (host.requireProject().path !== current.path) throw new Error('选择实例时工程已切换，请重试')
          const state = await bindShaderInstance(current, selected.filePaths[0]), saved = await readRuntimeBinding(bindingDirectory, current)
          await saveRuntimeBinding(bindingDirectory, current, { instancePath: state.instancePath!, ...(saved && saved.instancePath === state.instancePath && saved.runtimeRoot ? { runtimeRoot: saved.runtimeRoot } : {}) })
          return state
        }
        if (input.operation === 'bind-runtime') {
          if (!context.windowId || context.surface) throw new Error('请在游戏验证页面选择运行库；MCP 不能指定外部执行目录')
          const saved = await readRuntimeBinding(bindingDirectory, current)
          if (!saved) throw new Error('请先在此页面选择 Iris 实例')
          const window = host.mainWindow
          if (!window || window.isDestroyed()) throw new Error('请打开光影游戏验证页面')
          const selected = await dialog.showOpenDialog(window, { title: '选择游戏运行库目录', properties: ['openDirectory'] })
          if (selected.canceled || !selected.filePaths[0]) return null
          const runtimeRoot = await fs.realpath(selected.filePaths[0])
          for (const name of ['versions', 'libraries', 'assets']) if (!(await fs.stat(await safeFile(runtimeRoot, name))).isDirectory()) throw new Error('运行库目录需要包含 versions、libraries 和 assets')
          if (host.requireProject().path !== current.path) throw new Error('选择运行库时项目已切换')
          await saveRuntimeBinding(bindingDirectory, current, { ...saved, runtimeRoot }); javaCache = undefined
          return session.capabilities(current)
        }
        throw new Error('不支持的游戏验证操作')
      },
      session: async (input, context) => {
        if (context.readOnly) throw new Error('灵感台只允许读取测试状态')
        const operation = input.operation, current = operation === 'stop' ? project(context) : mutable(context)
        if (operation === 'start') return session.start(current, String(input.versionId), context.signal)
        if (operation === 'stop') return session.stop(current, String(input.sessionId))
        if (operation === 'reload') return session.observe(current, String(input.sessionId), true, context.signal)
        throw new Error('不支持的光影测试会话操作')
      }
    })
  }
}
