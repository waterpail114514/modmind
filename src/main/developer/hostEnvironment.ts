// Loaded before application services so the compatibility process never opens the user's profile.
import { app } from 'electron'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const developerHostConfig = process.send && process.env.MODMIND_DEVELOPER_HOST_CONFIG
  ? JSON.parse(readFileSync(process.env.MODMIND_DEVELOPER_HOST_CONFIG, 'utf8')) as { kit: string; profile: string; application: string; pluginId: string }
  : null

if (developerHostConfig) {
  const profile = realpathSync(developerHostConfig.profile)
  if (!profile.split(path.sep).includes('.modmind-dev')) throw new Error('开发预览的数据目录无效')
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  if (path.resolve(app.getAppPath()) !== path.resolve(developerHostConfig.application)) throw new Error('开发预览宿主目录不匹配')
  delete process.env.ELECTRON_RENDERER_URL
  delete process.env.MODMIND_E2E
  delete process.env.MODTOOL_E2E
  // Queue the init request until the real feature host has finished starting.
  require(path.join(developerHostConfig.kit, 'runtime.cjs'))
}
