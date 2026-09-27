import type { ProjectInfo } from '../../../shared/types'
import type { ReleaseSettings } from '../../../shared/production'

export const defaultRelease = (project: ProjectInfo): ReleaseSettings => ({
  version: '0.1.0',
  displayName: `${project.name} 0.1.0`,
  summary: '',
  changelog: '',
  autoBump: true,
  bumpMode: 'patch',
  channel: 'release',
  modrinthProjectId: '',
  curseForgeProjectId: '',
  githubRepository: ''
})

export const RELEASE_SETTINGS_CHANGED = 'modmind:release-settings-changed'

export async function saveReleasePatch(patch: Partial<ReleaseSettings>): Promise<ReleaseSettings> {
  const current = await window.modmind.production.release.getSettings()
  const saved = await window.modmind.production.release.saveSettings({ ...current, ...patch })
  window.dispatchEvent(new Event(RELEASE_SETTINGS_CHANGED))
  return saved
}
