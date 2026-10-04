import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AiModelInfo, ModelImageCapability } from '../shared/types'

const MAX_ENTRIES = 500
const MAX_BYTES = 128 * 1024
const MAX_AGE = 24 * 60 * 60_000
export interface ImageRequestObservation {
  baseUrl: string
  apiKey: string
  model: string
  protocol: 'responses' | 'chat-completions'
  status: number
  completed?: boolean
  errorBody?: string
}

export function explicitlyRejectsImageInput(status: number, body: string): boolean {
  if (![400, 415, 422].includes(status)) return false
  let message = ''
  try {
    const parsed = JSON.parse(body)
    message = typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.message === 'string' ? parsed.message : ''
  } catch { return false }
  // Format, size and detail errors do not establish lack of model vision.
  return /(?:does not|doesn't|cannot|can't|not).*support.*(?:image|vision|multimodal)|unsupported (?:image|vision|multimodal)(?: input)?|(?:image|vision|multimodal)\s+(?:input\s+)?(?:is\s+|are\s+)?(?:not supported|unsupported)|only supports? text(?:\s+(?:input|messages)|[.!]?\s*$)|(?:模型|model)[\s\S]{0,100}(?:不支持|not support)[\s\S]{0,30}(?:图像|图片|image|vision)/i.test(message)
    && !/image[_ ]detail|(?:format|mime|size|resolution|encoding|url|base64)[\s\S]{0,60}(?:unsupported|not supported|invalid)|unsupported[\s\S]{0,30}(?:format|mime|size|resolution|encoding|url|base64|file type)/i.test(message)
}

export class ModelImageCapabilities {
  private entries = new Map<string, ModelImageCapability>()
  private loaded?: Promise<void>
  private writes = Promise.resolve()
  constructor(private file?: () => string, private now: () => number = Date.now) {}

  private key(baseUrl: string, apiKey: string, model: string): string {
    const url = new URL(baseUrl)
    url.hash = ''
    return createHash('sha256').update(JSON.stringify([url.toString().replace(/\/$/, ''), apiKey.trim(), model])).digest('hex')
  }

  async load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return
      try {
        if ((await fs.stat(this.file())).size > MAX_BYTES) return
        const text = await fs.readFile(this.file(), 'utf8')
        if (Buffer.byteLength(text) > MAX_BYTES) return
        const data = JSON.parse(text)
        if (data.version !== 1 || !Array.isArray(data.entries)) return
        for (const entry of data.entries.slice(-MAX_ENTRIES)) {
          if (!Array.isArray(entry) || entry.length !== 2) continue
          const [key, value] = entry
          if (/^[a-f0-9]{64}$/.test(key) && ['supported', 'unsupported'].includes(value?.status)
            && ['provider', 'request', 'probe'].includes(value?.source) && Number.isFinite(value?.checkedAt)
            && value.checkedAt <= this.now() && this.now() - value.checkedAt < MAX_AGE
            && (value.protocol === undefined || ['responses', 'chat-completions'].includes(value.protocol))) {
            this.entries.set(key, { status: value.status, source: value.source, checkedAt: value.checkedAt, ...(value.protocol ? { protocol: value.protocol } : {}) })
          }
        }
      } catch { /* Corrupt or missing cache leaves capabilities unknown. */ }
    })()
    return this.loaded
  }

  resolve(baseUrl: string, apiKey: string, model: string): ModelImageCapability {
    const key = this.key(baseUrl, apiKey, model), value = this.entries.get(key)
    if (value?.checkedAt !== undefined && this.now() - value.checkedAt < MAX_AGE) return { ...value, scope: key }
    this.entries.delete(key)
    return { status: 'unknown', source: 'unknown', scope: key }
  }

  async enrich(models: AiModelInfo[], baseUrl: string, apiKey: string): Promise<AiModelInfo[]> {
    await this.load()
    const result = models.map(model => {
      const observed = this.resolve(baseUrl, apiKey, model.id)
      if (observed.source === 'request' || observed.source === 'probe') return { ...model, imageInput: observed }
      if (model.imageInput && model.imageInput.status !== 'unknown') {
        const imageInput = { ...model.imageInput, checkedAt: this.now() }
        this.set(this.key(baseUrl, apiKey, model.id), imageInput)
        return { ...model, imageInput: this.resolve(baseUrl, apiKey, model.id) }
      }
      this.entries.delete(this.key(baseUrl, apiKey, model.id))
      return { ...model, imageInput: this.resolve(baseUrl, apiKey, model.id) }
    })
    await this.persist()
    return result
  }

  async observe(observation: ImageRequestObservation): Promise<void> {
    const { baseUrl, apiKey, model, protocol, status, completed, errorBody } = observation
    const supported = status >= 200 && status < 300 && completed === true
    if (!supported && !explicitlyRejectsImageInput(status, errorBody ?? '')) return
    await this.load()
    if (supported && this.resolve(baseUrl, apiKey, model).source === 'probe') return
    this.set(this.key(baseUrl, apiKey, model), { status: supported ? 'supported' : 'unsupported', source: 'request', checkedAt: this.now(), protocol })
    await this.persist()
  }

  async verified(baseUrl: string, apiKey: string, model: string): Promise<ModelImageCapability> {
    await this.load()
    const value: ModelImageCapability = { status: 'supported', source: 'probe', checkedAt: this.now() }
    this.set(this.key(baseUrl, apiKey, model), value)
    await this.persist()
    return this.resolve(baseUrl, apiKey, model)
  }

  async invalidateVerification(baseUrl: string, apiKey: string, model: string): Promise<void> {
    const value = this.resolve(baseUrl, apiKey, model)
    if (value.source !== 'probe') return
    this.set(this.key(baseUrl, apiKey, model), { status: 'supported', source: 'request', checkedAt: value.checkedAt })
    await this.persist()
  }

  private set(key: string, value: ModelImageCapability): void {
    this.entries.delete(key); this.entries.set(key, value)
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const content = JSON.stringify({ version: 1, entries: [...this.entries] })
    this.writes = this.writes.then(async () => {
      const file = this.file!(), temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(temporary, content, 'utf8')
        await fs.rename(temporary, file)
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    }).catch(() => undefined)
    return this.writes
  }
}
