export interface RuntimePlatformInfo {
  os: 'windows' | 'macos' | 'linux' | 'other'
  arch: 'x64' | 'arm64' | 'other'
  packaged: boolean
}

export function runtimePlatformInfo(platform: string, arch: string, packaged: boolean): RuntimePlatformInfo {
  return Object.freeze({
    os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'other',
    arch: arch === 'x64' || arch === 'arm64' ? arch : 'other',
    packaged
  })
}
