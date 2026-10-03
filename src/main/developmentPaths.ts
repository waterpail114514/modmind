import { mkdirSync } from 'node:fs'
import path from 'node:path'

interface DevelopmentApp {
  isPackaged: boolean
  getAppPath(): string
  commandLine: { getSwitchValue(name: string): string }
  setPath(name: 'userData' | 'sessionData', value: string): void
  setAppLogsPath(value: string): void
}

/** Run before reading preferences, creating sessions or taking the instance lock. */
export function configureDevelopmentPaths(app: DevelopmentApp, env = process.env): string | undefined {
  if (app.isPackaged) return undefined
  // Preserve the explicit profiles used by integration tests and local probes.
  const override = app.commandLine.getSwitchValue('user-data-dir') || env.MODMIND_DEV_USER_DATA_DIR?.trim()
  if (override && !path.isAbsolute(override)) throw new Error('Development user data directory must be absolute')
  const userData = override || path.join(app.getAppPath(), '.modmind-dev', 'userData')
  const logs = path.join(userData, 'logs')
  mkdirSync(logs, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.setAppLogsPath(logs)
  return userData
}
