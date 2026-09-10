import descriptors from './codexRuntimeDescriptors.json'

export const CODEX_RUNTIME_VERSION = descriptors.version
export function resolveCodexRuntimeTarget(platform: string = process.platform, arch: string = process.arch) {
  const descriptor = descriptors.targets.find((target) => target.id === `${platform}-${arch}`)
  return descriptor ? { supported: true as const, descriptor } : { supported: false as const, reason: `不支持的 Codex 平台/架构：${platform}-${arch}` }
}
export function requireCodexRuntimeTarget(platform: string = process.platform, arch: string = process.arch) {
  const target = resolveCodexRuntimeTarget(platform, arch)
  if (!target.supported) throw new Error(target.reason)
  return target.descriptor
}
