import type { MinecraftLaunchOptions, MinecraftLaunchTestResult } from '../shared/minecraft'

export async function runRenderedMinecraftTest(dependencies: {
  isRunning: () => boolean
  build: () => Promise<unknown>
  launch: (options: MinecraftLaunchOptions, stableWindowMs: number, signal?: AbortSignal) => Promise<MinecraftLaunchTestResult>
  stop: () => Promise<unknown>
}, signal?: AbortSignal): Promise<MinecraftLaunchTestResult & { visualVerified: false; gameplayVerified: false; clientStopped: true }> {
  signal?.throwIfAborted()
  if (dependencies.isRunning()) throw new Error('已有 Minecraft 实例正在运行，请先停止；不会接管或关闭用户的游戏')
  await dependencies.build()
  signal?.throwIfAborted()
  if (dependencies.isRunning()) throw new Error('构建期间已有 Minecraft 实例启动，不会接管或关闭用户的游戏')
  let result: MinecraftLaunchTestResult
  try {
    result = await dependencies.launch({ username: 'ModMindTest', maxMemoryMb: 2048, width: 960, height: 600 }, 20_000, signal)
  } finally {
    await dependencies.stop()
  }
  return { ...result, visualVerified: false, gameplayVerified: false, clientStopped: true }
}
