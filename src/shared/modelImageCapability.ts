import type { ModelImageCapability } from './types'

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function parseModelImageCapability(value: unknown): ModelImageCapability | undefined {
  const model = record(value)
  if (!model) return undefined
  const modalities = model.input_modalities ?? record(model.modalities)?.input ?? record(model.architecture)?.input_modalities
  if (Array.isArray(modalities) && modalities.length && modalities.every(item => typeof item === 'string')) {
    return { source: 'provider', status: modalities.includes('image') ? 'supported' : 'unsupported' }
  }
  const flag = model.supports_image_input ?? model.supports_vision ?? record(model.capabilities)?.vision
  if (typeof flag === 'boolean') return { source: 'provider', status: flag ? 'supported' : 'unsupported' }
  // A partial capabilities list only establishes support when vision is explicit.
  if (Array.isArray(model.capabilities) && model.capabilities.includes('vision')) return { source: 'provider', status: 'supported' }
  return undefined
}

export function modelImageCapabilityLabel(capability?: ModelImageCapability): string {
  if (!capability || capability.status === 'unknown') return '图像能力未知'
  if (capability.source === 'probe') return '识图已验证'
  if (capability.source === 'request') return capability.status === 'supported' ? '上游已接受图像' : '图像输入已被上游拒绝'
  return capability.status === 'supported' ? '上游声明支持图像' : '上游声明不支持图像'
}
