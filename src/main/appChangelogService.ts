import { promises as fs } from 'node:fs'
import path from 'node:path'
import { APP_CHANGELOG, type AppChangelogSnapshot } from '../shared/appChangelog'
import { compareSemanticAppVersions, parseAppVersion } from './appUpdatePolicy'

interface ChangelogState {
  schemaVersion: 1
  highestVersion: string
  pendingVersion: string | null
}

interface ChangelogOptions {
  userDataPath: string
  currentVersion: string
  isPackaged: boolean
  installMarkerPath?: string
}

export class AppChangelogService {
  private state: ChangelogState | null = null
  private automatic = false

  constructor(private readonly options: ChangelogOptions) {}

  private get statePath(): string { return path.join(this.options.userDataPath, 'app-changelog-state.json') }

  async initialize(): Promise<void> {
    const { currentVersion, isPackaged } = this.options
    if (!isPackaged || !parseAppVersion(currentVersion)) return
    let previous: ChangelogState | null = null
    let missing = false
    try {
      const value = JSON.parse(await this.readSmallFile(this.statePath)) as Partial<ChangelogState> | null
      if (value?.schemaVersion === 1 && typeof value.highestVersion === 'string' && parseAppVersion(value.highestVersion)
        && (value.pendingVersion === null || value.pendingVersion === value.highestVersion)) previous = value as ChangelogState
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!missing) console.warn('[changelog] launch record unavailable', error)
    }
    // Only a genuinely missing record may use the installer migration hint.
    // Corrupt records establish a quiet baseline instead of guessing an upgrade.
    const previousVersion = previous?.highestVersion ?? (missing ? await this.installedPreviousVersion() : null)
    const upgraded = previousVersion !== null && (compareSemanticAppVersions(currentVersion, previousVersion) ?? 0) > 0
    const hasNotes = APP_CHANGELOG.some(release => compareSemanticAppVersions(release.version, currentVersion) === 0)
    this.automatic = hasNotes && (upgraded || previous?.pendingVersion === currentVersion)
    this.state = {
      schemaVersion: 1,
      highestVersion: previousVersion && !upgraded ? previousVersion : currentVersion,
      pendingVersion: this.automatic ? currentVersion : null
    }
    try { await this.save() } catch (error) {
      // If persistence is unavailable, avoid a popup that would repeat every launch.
      this.automatic = false
      console.warn('[changelog] could not save launch record', error)
    }
  }

  snapshot(): AppChangelogSnapshot {
    return {
      currentVersion: this.options.currentVersion,
      automatic: this.automatic,
      releases: APP_CHANGELOG.filter(release => {
        const comparison = compareSemanticAppVersions(release.version, this.options.currentVersion)
        return comparison !== null && comparison <= 0
      })
    }
  }

  async markPresented(): Promise<void> {
    if (!this.automatic || !this.state) return
    this.automatic = false
    this.state.pendingVersion = null
    await this.save()
  }

  private async installedPreviousVersion(): Promise<string | null> {
    if (!this.options.installMarkerPath) return null
    try {
      const [installed, previous] = (await this.readSmallFile(this.options.installMarkerPath)).trim().split(/\r?\n/)
      return installed === this.options.currentVersion && previous && parseAppVersion(previous) ? previous : null
    } catch { return null }
  }

  private async readSmallFile(file: string): Promise<string> {
    if ((await fs.stat(file)).size > 16 * 1024) throw new Error('Launch record is too large')
    return fs.readFile(file, 'utf8')
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.options.userDataPath, { recursive: true })
    const temporary = this.statePath + '.tmp'
    await fs.writeFile(temporary, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.statePath)
  }
}
