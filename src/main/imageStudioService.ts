import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import sharp from 'sharp'
import { downloadActivities } from './downloadActivityService'
import { runEmbeddedPerfectPixel } from './perfectPixel'
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageHistoryItem,
  ImageProcessingOptions,
  ImageProcessingResult,
  ImageStudioCapabilities,
  ImageStudioSettings,
  ImageStudioSettingsInput,
  ImageStudioQuality,
  ImageStudioModeration
} from '../shared/imageStudio'

const IMAGE_SETTINGS_VERSION = 1
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
interface StoredSettings {
  version: number
  baseUrl: string
  model: string
  encryptedKey?: string
  allowAgentImages: boolean
  autoApproveAgentImages: boolean
  manualHostedConsent: boolean
}

interface HostedLease {
  baseUrl: string
  apiKey: string
  jobId: string
  reservedCredits: number
  capabilities?: Partial<ImageStudioCapabilities>
}

export interface ImageStudioServiceOptions {
  userDataDir: string
  projectRoot: () => string | null
  getHostedLease: (request?: ImageGenerationRequest) => Promise<HostedLease>
}

function normalizeBaseUrl(value: string): string {
  if (!value.trim()) return ''
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片服务地址必须使用 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('图片服务地址不能包含账号密码')
  return url.toString().replace(/\/$/, '')
}

function settingsPath(root: string): string { return path.join(root, 'image-studio-settings.json') }
function historyPath(root: string): string { return path.join(root, 'image-studio-history.json') }

function defaults(): ImageStudioSettings {
  return {
    baseUrl: '',
    model: '',
    hasStoredKey: false,
    allowAgentImages: true,
    autoApproveAgentImages: true,
    manualHostedConsent: true
  }
}

function dataUrlFromValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value
  if (/^https?:\/\//i.test(value)) return value
  if (/^[A-Za-z0-9+/=]+$/.test(value)) return `data:image/png;base64,${value}`
  return null
}

async function materializeImageValue(value: unknown): Promise<string | null> {
  const dataUrl = dataUrlFromValue(value)
  if (!dataUrl) return null
  if (dataUrl.startsWith('data:')) return dataUrl
  const activityId = downloadActivities.start({ label: '生成的图片', detail: new URL(dataUrl).host })
  let bytes: Buffer
  try {
    const response = await fetch(dataUrl, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('上游图片为空或超过 20 MB')
    downloadActivities.update(activityId, { downloadedBytes: bytes.length, totalBytes: Number(response.headers.get('content-length')) || bytes.length })
    downloadActivities.complete(activityId)
  } catch (error) {
    downloadActivities.fail(activityId, error)
    throw error
  }
  const normalized = await sharp(bytes).png().toBuffer()
  return `data:image/png;base64,${normalized.toString('base64')}`
}

function parseReferenceImage(value: string): { buffer: Buffer; mime: string; extension: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim())
  if (!match) throw new Error('参考图必须是 PNG、JPEG、WebP、GIF 或 BMP 图片')
  const mime = match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('参考图不能为空且不能超过 20 MB')
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)
  return { buffer, mime, extension }
}

async function parseImagePayload(payload: unknown): Promise<{ dataUrl: string; revisedPrompt?: string }[]> {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const entries = Array.isArray(root.data) ? root.data : []
  const parsed = await Promise.all(entries.map(async (entry) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const dataUrl = await materializeImageValue(dataUrlFromValue(item.b64_json) ?? item.url)
    if (!dataUrl) return null
    return { dataUrl, ...(typeof item.revised_prompt === 'string' ? { revisedPrompt: item.revised_prompt } : {}) }
  }))
  return parsed.filter((entry): entry is { dataUrl: string; revisedPrompt?: string } => Boolean(entry))
}

function clampQuality(value: unknown): ImageStudioQuality {
  return value === 'low' || value === 'high' || value === 'auto' ? value : 'medium'
}

function clampModeration(value: unknown): ImageStudioModeration { return value === 'low' ? 'low' : 'auto' }

async function removeSolidBackground(source: Buffer): Promise<Buffer> {
  const normalized = await sharp(source).ensureAlpha().png().toBuffer()
  const raw = await sharp(normalized).raw().toBuffer({ resolveWithObject: true })
  const channels = raw.info.channels
  if (channels < 4) throw new Error('无法读取图像颜色数据')

  const corners = [
    0,
    (raw.info.width - 1) * channels,
    ((raw.info.height - 1) * raw.info.width) * channels,
    (((raw.info.height - 1) * raw.info.width) + raw.info.width - 1) * channels
  ]
  let bestColor = [raw.data[0], raw.data[1], raw.data[2]]
  let bestCount = -1
  const backgroundSamples = new Map<string, { count: number; color: number[] }>()
  for (const corner of corners) {
    const color = [raw.data[corner], raw.data[corner + 1], raw.data[corner + 2]]
    const key = `${color[0] >> 4}:${color[1] >> 4}:${color[2] >> 4}`
    if (!backgroundSamples.has(key)) backgroundSamples.set(key, { count: 0, color })
    const sample = backgroundSamples.get(key)!
    sample.count += 1
    if (sample.count > bestCount) {
      bestCount = sample.count
      bestColor = sample.color
    }
  }

  for (let index = 0; index < raw.data.length; index += channels) {
    const distance = Math.sqrt(
      (raw.data[index] - bestColor[0]) ** 2 +
      (raw.data[index + 1] - bestColor[1]) ** 2 +
      (raw.data[index + 2] - bestColor[2]) ** 2
    )
    if (distance <= 42) {
      raw.data[index + 3] = distance <= 24 ? 0 : Math.round(((distance - 24) / 18) * 255)
    }
  }
  return sharp(raw.data, { raw: raw.info }).png().toBuffer()
}

export class ImageStudioService {
  constructor(private readonly options: ImageStudioServiceOptions) {}

  private async readStored(): Promise<StoredSettings> {
    try {
      const value = JSON.parse(await fs.readFile(settingsPath(this.options.userDataDir), 'utf8')) as Partial<StoredSettings>
      return {
        version: IMAGE_SETTINGS_VERSION,
        baseUrl: normalizeBaseUrl(typeof value.baseUrl === 'string' ? value.baseUrl : ''),
        model: typeof value.model === 'string' ? value.model.trim().slice(0, 128) : '',
        ...(typeof value.encryptedKey === 'string' && value.encryptedKey ? { encryptedKey: value.encryptedKey } : {}),
        allowAgentImages: true,
        autoApproveAgentImages: true,
        manualHostedConsent: true
      }
    } catch {
      return { version: IMAGE_SETTINGS_VERSION, ...defaults() }
    }
  }

  private async decryptKey(stored?: StoredSettings): Promise<string> {
    const value = stored ?? await this.readStored()
    if (!value.encryptedKey || !safeStorage.isEncryptionAvailable()) return ''
    try { return safeStorage.decryptString(Buffer.from(value.encryptedKey, 'base64')).trim() } catch { return '' }
  }

  async revealApiKey(): Promise<string> {
    return this.decryptKey()
  }

  async getSettings(): Promise<ImageStudioSettings> {
    const stored = await this.readStored()
    return { baseUrl: stored.baseUrl, model: stored.model, hasStoredKey: Boolean(stored.encryptedKey), allowAgentImages: stored.allowAgentImages, autoApproveAgentImages: stored.autoApproveAgentImages, manualHostedConsent: stored.manualHostedConsent }
  }

  async saveSettings(input: ImageStudioSettingsInput): Promise<ImageStudioSettings> {
    const stored = await this.readStored()
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    const clearApiKey = input.clearApiKey === true
    if (apiKey && !clearApiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法保存图片 API Key')
    const next: StoredSettings = {
      version: IMAGE_SETTINGS_VERSION,
      baseUrl: normalizeBaseUrl(input.baseUrl || ''),
      model: String(input.model || '').trim().slice(0, 128),
      allowAgentImages: true,
      autoApproveAgentImages: true,
      manualHostedConsent: true,
      ...(!clearApiKey && apiKey
        ? { encryptedKey: safeStorage.encryptString(apiKey).toString('base64') }
        : !clearApiKey && stored.encryptedKey
          ? { encryptedKey: stored.encryptedKey }
          : {})
    }
    await fs.mkdir(this.options.userDataDir, { recursive: true })
    await fs.writeFile(settingsPath(this.options.userDataDir), JSON.stringify(next, null, 2), 'utf8')
    return this.getSettings()
  }

  async capabilities(): Promise<ImageStudioCapabilities> {
    const stored = await this.readStored()
    const ownKey = await this.decryptKey(stored)
    const lease = ownKey ? null : await this.options.getHostedLease()
    const key = lease?.apiKey ?? ownKey
    const baseUrl = lease?.baseUrl ?? stored.baseUrl
    if (!baseUrl) throw new Error('请先在图像服务设置中填写并保存 Base URL')
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`无法读取图片模型列表（HTTP ${response.status}）`)
    const payload = await response.json() as { data?: Array<{ id?: unknown }> }
    const models = [...new Set((Array.isArray(payload.data) ? payload.data : []).map((item) => typeof item?.id === 'string' ? item.id.trim() : '').filter(Boolean))]
    return { models, sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', 'auto'], qualities: ['low', 'medium', 'high', 'auto'], moderations: ['auto', 'low'], supportsImageInput: true, supportsMask: true }
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const prompt = String(request.prompt ?? '').trim()
    if (!prompt || prompt.length > 32_000) throw new Error('请输入 1 到 32000 个字符的图片描述')
    const count = Math.min(Math.max(Number.isInteger(request.count) ? request.count : 1, 1), 10)
    const stored = await this.readStored()
    const ownKey = await this.decryptKey(stored)
    const hosted = !ownKey
    if (!stored.model) throw new Error('请先在图像服务设置中选择并保存图片模型')
    if (ownKey && !stored.baseUrl) throw new Error('请先在图像服务设置中填写并保存 Base URL')
    const lease = hosted ? await this.options.getHostedLease({ ...request, count }) : null
    const baseUrl = lease?.baseUrl ?? stored.baseUrl
    const apiKey = lease?.apiKey ?? ownKey
    const model = stored.model
    const stylePrefix = request.style === 'minecraft'
      ? `Minecraft pixel art asset, crisp hard-edged pixels, flat solid ${request.backgroundColor || '#ffffff'} background, no gradients, no shadows. `
      : ''
    const body = {
      model,
      prompt: `${stylePrefix}${prompt}`,
      n: count,
      size: String(request.size || '1024x1024'),
      quality: clampQuality(request.quality),
      moderation: clampModeration(request.moderation)
    }
    const reference = request.referenceImage ? parseReferenceImage(request.referenceImage) : null
    let requestBody: BodyInit = JSON.stringify(body)
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
    const endpoint = reference ? 'images/edits' : 'images/generations'
    if (reference) {
      const form = new FormData()
      form.append('model', body.model)
      form.append('prompt', body.prompt)
      form.append('n', String(body.n))
      form.append('size', body.size)
      form.append('quality', body.quality)
      form.append('moderation', body.moderation)
      form.append('image', new Blob([new Uint8Array(reference.buffer)], { type: reference.mime }), `reference.${reference.extension}`)
      requestBody = form
    } else {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers, body: requestBody, signal: AbortSignal.timeout(300_000) })
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) throw new Error(`图片生成失败（HTTP ${response.status}）：${typeof payload?.error === 'string' ? payload.error : '上游未返回可读错误'}`)
    const parsed = await parseImagePayload(payload)
    if (!parsed.length) throw new Error('图片服务没有返回可用图片数据')
    const jobId = lease?.jobId ?? randomUUID()
    const createdAt = new Date().toISOString()
    const assets: ImageHistoryItem[] = parsed.map((item) => ({ id: randomUUID(), createdAt, model, style: request.style, size: body.size, quality: body.quality, hosted, credits: hosted ? (lease?.reservedCredits ?? count) : 0 }))
    const history = await this.readHistory()
    await fs.mkdir(this.options.userDataDir, { recursive: true })
    await fs.writeFile(historyPath(this.options.userDataDir), JSON.stringify([...assets, ...history].slice(0, 100), null, 2), 'utf8')
    return { jobId, assets: assets.map((asset, index) => ({ ...asset, dataUrl: parsed[index].dataUrl })), hosted, credits: hosted ? (lease?.reservedCredits ?? count) : 0, ...(parsed[0].revisedPrompt ? { revisedPrompt: parsed[0].revisedPrompt } : {}) }
  }

  async process(operation: 'perfect-pixel' | 'remove-background', dataUrl: string, options?: ImageProcessingOptions): Promise<ImageProcessingResult> {
    const match = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
    if (!match) throw new Error('图片数据格式无效')
    const encoded = match[1]
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('图片数据超过 20 MB 处理上限')
    const source = Buffer.from(encoded, 'base64')
    if (!source.length || source.length > MAX_IMAGE_BYTES) throw new Error('图片数据为空或超过 20 MB')
    const metadata = await sharp(source).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (!width || !height) throw new Error('无法读取图片尺寸')
    let output: Buffer
    if (operation === 'perfect-pixel') {
      try {
        output = await runEmbeddedPerfectPixel(source, options?.perfectPixel)
        return { dataUrl: `data:image/png;base64,${output.toString('base64')}`, operation, detail: '已使用内置 PerfectPixel 完成像素优化' }
      } catch {
        const smallWidth = Math.max(16, Math.min(128, Math.round(Math.min(width, height) / 8)))
        const smallHeight = Math.max(1, Math.round(height / width * smallWidth))
        output = await sharp(source).resize(smallWidth, smallHeight, { fit: 'fill', kernel: sharp.kernel.nearest }).resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest }).png().toBuffer()
      }
    } else {
      output = await removeSolidBackground(source)
    }
    return { dataUrl: `data:image/png;base64,${output.toString('base64')}`, operation, detail: operation === 'perfect-pixel' ? 'PerfectPixel 不可用，已使用本地最近邻回退' : '已按检测到的纯色背景完成去背' }
  }

  async history(): Promise<ImageHistoryItem[]> { return this.readHistory() }

  private async readHistory(): Promise<ImageHistoryItem[]> {
    try { return JSON.parse(await fs.readFile(historyPath(this.options.userDataDir), 'utf8')) as ImageHistoryItem[] } catch { return [] }
  }
}

export function imageStudioDefaults(): ImageStudioSettings { return defaults() }
