import type { ImageGenerationRequest, ImageStudioSource, PerfectPixelOptions } from './imageStudio'
import { findImageStudioPreset, imageWorkflowPrompt } from './imageStudioPresets'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图像参数必须是对象')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  return value.trim()
}

function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback
  if (!choices.includes(value as T)) throw new Error(`${label}必须是 ${choices.join(' / ')}`)
  return value as T
}

function number(value: unknown, fallback: number, min: number, max: number, label: string, integer = false): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}必须是 ${min}～${max} 的${integer ? '整数' : '数字'}`)
  }
  return value
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`)
  return value
}

/** Both IPC and workbench enter Image Studio through this parser. Credentials never come from tool input. */
export function normalizeImageGenerationRequest(input: unknown, source: ImageStudioSource): ImageGenerationRequest {
  const value = record(input)
  const presetId = text(value.presetId, '预设')
  const preset = presetId ? findImageStudioPreset(presetId) : undefined
  if (presetId && !preset) throw new Error('图像预设不存在，请读取图像工坊可用预设')
  const presetPrompt = value.presetPrompt === undefined ? undefined : text(value.presetPrompt, '预设提示词')
  if (presetPrompt !== undefined && !preset) throw new Error('预设提示词需要指定 presetId')
  const prompt = imageWorkflowPrompt({ presetId, presetPrompt }, text(value.prompt, '图片描述'))
  if (!prompt || prompt.length > 32_000) throw new Error('请输入 1 到 32000 个字符的图片描述（含预设）')
  const referenceImage = text(value.referenceImage, '参考图')
  if (referenceImage && !/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(referenceImage)) throw new Error('参考图必须是图片 data URL')
  if (preset?.requiresReference && !referenceImage) throw new Error(`“${preset.label}”需要参考图`)
  const model = text(value.model, '图片模型')
  if (model.length > 128) throw new Error('图片模型名称不能超过 128 个字符')
  const size = text(value.size, '尺寸', '1024x1024')
  if (!/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/.test(size)) throw new Error('图片尺寸必须是 auto 或宽x高')
  const backgroundColor = text(value.backgroundColor, '背景色', '#ffffff')
  if (!/^#[\da-f]{6}$/i.test(backgroundColor)) throw new Error('背景色必须是六位十六进制颜色')
  return {
    prompt, source, ...(model ? { model } : {}), ...(referenceImage ? { referenceImage } : {}),
    style: preset ? 'free' : choice(value.style, ['minecraft', 'free'], 'free', '风格'),
    size, quality: choice(value.quality, ['low', 'medium', 'high', 'auto'], 'medium', '质量'),
    moderation: choice(value.moderation, ['auto', 'low'], 'auto', '审核'),
    count: number(value.count, 1, 1, 10, '批量数量', true),
    background: choice(value.background, ['solid', 'auto'], value.style === 'minecraft' && !preset ? 'solid' : 'auto', '背景'), backgroundColor,
    removeBackground: boolean(value.removeBackground, false, '去背')
  }
}

export function normalizePerfectPixelOptions(input: unknown): PerfectPixelOptions {
  const value = input === undefined ? {} : record(input)
  let gridSize: [number, number] | undefined
  if (value.gridSize !== undefined) {
    if (!Array.isArray(value.gridSize) || value.gridSize.length !== 2) throw new Error('网格尺寸必须包含宽和高')
    gridSize = value.gridSize.map(item => number(item, 16, 1, 4096, '网格尺寸', true)) as [number, number]
  }
  return {
    sampleMethod: choice(value.sampleMethod, ['majority', 'center', 'median'] as const, 'center', '采样方式'),
    minSize: number(value.minSize, 4, 0.1, 1000, '最小像素尺寸'),
    peakWidth: number(value.peakWidth, 6, 1, 1000, '峰值宽度', true),
    refineIntensity: number(value.refineIntensity, 0.3, 0, 0.5, '网格线修正强度'),
    fixSquare: boolean(value.fixSquare, true, '正方形修正'), ...(gridSize ? { gridSize } : {})
  }
}

export const imageGenerationInputSchema = {
  type: 'object', additionalProperties: false, required: ['prompt'], properties: {
    prompt: { type: 'string', maxLength: 32000 }, model: { type: 'string', maxLength: 128, description: 'Optional model override for this request only; otherwise uses the saved Image Studio model.' },
    presetId: { type: 'string', description: 'Preset ID from modmind_image_studio_info.' }, presetPrompt: { type: 'string', description: 'Editable preset template. prompt supplies additional requirements.' },
    style: { type: 'string', enum: ['minecraft', 'free'], default: 'free' }, size: { type: 'string', default: '1024x1024' },
    quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], default: 'medium' }, moderation: { type: 'string', enum: ['auto', 'low'], default: 'auto' },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 1 }, background: { type: 'string', enum: ['solid', 'auto'], description: 'solid adds a flat-background instruction to the prompt; auto leaves the background to the prompt.' },
    backgroundColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', default: '#ffffff' }, removeBackground: { type: 'boolean', default: false, description: 'Apply Image Studio local solid-background removal to generated pixels.' }, referenceImage: { type: 'string', description: 'Image data URL for reference-guided editing.' }
  }
} as const

export const perfectPixelInputSchema = {
  type: 'object', additionalProperties: false, properties: {
    sampleMethod: { type: 'string', enum: ['majority', 'center', 'median'], default: 'center' },
    gridSize: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 4096 }, description: 'Optional [width, height]; omit for automatic grid detection.' },
    minSize: { type: 'number', minimum: 0.1, maximum: 1000, default: 4 }, peakWidth: { type: 'integer', minimum: 1, maximum: 1000, default: 6 },
    refineIntensity: { type: 'number', minimum: 0, maximum: 0.5, default: 0.3 }, fixSquare: { type: 'boolean', default: true }
  }
} as const
