// Run before settings/services capture userData. Packaged apps never enable this mode.
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.join(app.getAppPath(), 'node_modules', '.cache', 'modmind-feature-dev')
const requested = process.env.MODMIND_FEATURE_DEV
export const featureDevelopment = !app.isPackaged && !process.env.MODMIND_DEVELOPER_HOST_CONFIG && requested
  && path.resolve(requested) === path.join(root, 'ready.json') ? { root, readyFile: path.join(root, 'ready.json'), profile: path.join(root, 'profile') } : null

if (featureDevelopment) {
  mkdirSync(featureDevelopment.profile, { recursive: true })
  app.setPath('userData', featureDevelopment.profile)
  app.setPath('sessionData', featureDevelopment.profile)
}
