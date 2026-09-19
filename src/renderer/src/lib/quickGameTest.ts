import type { ModMindApi, ProjectInfo } from '../../../shared/types'
import type { LocalTestState, MinecraftLaunchOptions, MinecraftRuntimeState } from '../../../shared/minecraft'
import { isJavaLoader } from '../../../shared/projectPlatform'

export function quickTestUnavailable(project: ProjectInfo): string | undefined {
  if (project.draft) return '请先确认项目信息并完成制作。'
  if (project.loader === 'velocity') return 'Velocity 是代理插件，需要配置后端世界服后才能进入游戏测试。'
  if (project.loader === 'bedrock') return '基岩版需要将导出的 .mcaddon 导入已安装的 Minecraft 客户端。'
  if (!isJavaLoader(project.loader) && project.kind !== 'server-plugin') return '网易版需要在官方开发者工作台中打开工程并启动测试。'
  return undefined
}

export function quickTestOptions(storage: Pick<Storage, 'getItem'>): MinecraftLaunchOptions {
  const username = storage.getItem('modmind.minecraft.username')?.trim() ?? ''
  const memory = Number(storage.getItem('modmind.minecraft.memory'))
  return {
    username: /^[A-Za-z0-9_]{3,16}$/.test(username) ? username : 'ModMindDev',
    maxMemoryMb: Number.isInteger(memory) && memory >= 1024 && memory <= 16384 ? memory : 4096,
    width: 1280,
    height: 720
  }
}

export async function launchQuickGameTest(
  api: Pick<ModMindApi, 'project' | 'minecraft' | 'localTest'>,
  project: ProjectInfo,
  options: MinecraftLaunchOptions,
  signal: AbortSignal
): Promise<MinecraftRuntimeState | LocalTestState> {
  const unavailable = quickTestUnavailable(project)
  if (unavailable) throw new Error(unavailable)
  const checkProject = async (): Promise<void> => {
    signal.throwIfAborted()
    const current = await api.project.current()
    signal.throwIfAborted()
    if (current?.path !== project.path) throw new Error('当前项目已切换，请在对应作品中重新测试。')
  }
  await checkProject()
  if (project.kind === 'server-plugin') {
    const state = await api.localTest.getState()
    await checkProject()
    if (state?.active) {
      if (state.projectPath === project.path && state.stage !== 'error') return state
      throw new Error('请先停止当前测试，再重新启动。')
    }
    const started = await api.localTest.start({ username: options.username, maxMemoryMb: options.maxMemoryMb })
    if (started.stage === 'error') throw new Error(started.message)
    return started
  }
  const state = await api.minecraft.getState()
  await checkProject()
  if (state.running) return state
  if (project.kind === 'modpack') await api.minecraft.syncModpack()
  else await api.minecraft.buildProject(project.path)
  await checkProject()
  const launched = await api.minecraft.launch(options)
  if (launched.stage === 'error') throw new Error(launched.message)
  return launched
}
