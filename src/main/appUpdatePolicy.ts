export type AppReleaseChannel = 'stable' | 'beta'

interface ParsedAppVersion {
  raw: string
  numbers: number[]
  prerelease: string[]
  channel: AppReleaseChannel
}

export interface AppUpdateDecision {
  currentVersion: string
  latestVersion: string
  currentChannel: AppReleaseChannel
  targetChannel: AppReleaseChannel
  updateAvailable: boolean
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null
    const bNumber = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null
    if (aNumber !== null && bNumber !== null) return aNumber - bNumber
    if (aNumber !== null) return -1
    if (bNumber !== null) return 1
    return a.localeCompare(b, 'en', { sensitivity: 'base' })
  }
  return 0
}

export function parseAppVersion(value: string): ParsedAppVersion | null {
  const raw = value.trim()
  const match = raw.match(/^v?(\d+(?:\.\d+){2})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  const numbers = match[1].split('.').map((part) => Number.parseInt(part, 10))
  const prerelease = match[2]?.split('.').filter(Boolean) ?? []
  return { raw, numbers, prerelease, channel: prerelease.length ? 'beta' : 'stable' }
}

export function compareSemanticAppVersions(left: string, right: string): number | null {
  const a = parseAppVersion(left)
  const b = parseAppVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function decideAppUpdate(currentVersion: string, latestVersion: string): AppUpdateDecision | null {
  const current = parseAppVersion(currentVersion)
  const latest = parseAppVersion(latestVersion)
  if (!current || !latest) return null

  let updateAvailable = false
  if (latest.channel === 'beta' && current.channel === 'stable') {
    updateAvailable = false
  } else {
    // A prerelease may advance to its stable version, never an older stable release.
    updateAvailable = (compareSemanticAppVersions(latest.raw, current.raw) ?? 0) > 0
  }

  return {
    currentVersion: current.raw,
    latestVersion: latest.raw,
    currentChannel: current.channel,
    targetChannel: latest.channel,
    updateAvailable
  }
}
