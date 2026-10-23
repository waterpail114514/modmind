import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { load } from 'cheerio'
import type {
  McmodCaptchaChallenge,
  McmodDownloadResult,
  McmodFileInfo,
  McmodManualRequirement,
  McmodSearchResult,
  ProjectInfo
} from '../shared/types'
import { verifiedDownload } from './downloadService'
import { auditModpackLock, readModpackLock, writeModpackLock, type LockedMod } from './modpackLockService'
import { isSafeModJarFileName } from './modpackFilename'
import { readModpackManifest, writeModpackManifest } from './modpackService'
import { modpackModsRoot } from './modpackPaths'
import { isJavaLoader } from '../shared/projectPlatform'
import { withProjectMutation } from './projectMutation'
import { assertContentTarget } from './contentInstallTransaction'

const MCMOD_ORIGIN = 'https://www.mcmod.cn'
const MCMOD_SEARCH_ORIGIN = 'https://search.mcmod.cn'
const REQUESTS_PER_MINUTE = 25
const MAX_REQUEST_ATTEMPTS = 3
const SESSION_TTL_MS = 5 * 60_000
const USER_AGENT = 'ModMind/1.3 (manual-mod-workflow)'

type FetchLike = typeof fetch

export class McmodProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly diagnostic?: string
  ) {
    super(message)
    this.name = 'McmodProviderError'
  }
}

interface DownloadSession {
  id: string
  projectPath: string
  file: McmodFileInfo
  fileToken: string
  attempts: number
  expiresAt: number
  captchaDataUrl: string
  mode: 'modpack' | 'addon'
}

interface ParsedDownloadPage {
  fileToken: string
  files: McmodFileInfo[]
  md5ByFileKey: Map<string, string>
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(Object.assign(new Error('MC百科请求已取消'), { name: 'AbortError' }))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 60_000) : null
}

function safeDiagnostic(url: string, status: number): string {
  const parsed = new URL(url)
  return `MC百科返回 HTTP ${status}（${parsed.origin}${parsed.pathname}）`
}

function cookiePairs(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])
  return values.flatMap((value) => {
    const pair = value.split(';', 1)[0]?.trim()
    return pair && pair.includes('=') ? [pair] : []
  })
}

export class McmodHttpClient {
  private readonly requestTimes: number[] = []
  private readonly cookies = new Map<string, string>()
  private blockedDiagnostic = ''

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      const now = Date.now()
      while (this.requestTimes.length && this.requestTimes[0] <= now - 60_000) this.requestTimes.shift()
      if (this.requestTimes.length < REQUESTS_PER_MINUTE) {
        this.requestTimes.push(now)
        return
      }
      await delay(Math.max(50, this.requestTimes[0] + 60_000 - now), signal)
    }
  }

  private rememberCookies(url: string, response: Response): void {
    const host = new URL(url).hostname
    const current = new Map((this.cookies.get(host) ?? '').split(';').map((value) => value.trim()).filter(Boolean).map((value) => {
      const separator = value.indexOf('=')
      return [value.slice(0, separator), value.slice(separator + 1)]
    }))
    for (const pair of cookiePairs(response)) {
      const separator = pair.indexOf('=')
      current.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    this.cookies.set(host, [...current].map(([name, value]) => `${name}=${value}`).join('; '))
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.blockedDiagnostic) throw new McmodProviderError('MC百科当前已停止访问，请稍后重启客户端再试', 403, this.blockedDiagnostic)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !['www.mcmod.cn', 'search.mcmod.cn'].includes(parsed.hostname)) {
      throw new McmodProviderError('MC百科请求地址不受信任')
    }
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      await this.acquire(init.signal ?? undefined)
      const cookie = this.cookies.get(parsed.hostname) ?? this.cookies.get('www.mcmod.cn') ?? ''
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(init.headers ?? {})
          },
          signal: init.signal ?? AbortSignal.timeout(30_000)
        })
      } catch (error) {
        lastError = error
        if (attempt + 1 >= MAX_REQUEST_ATTEMPTS) break
        await delay(750 * 2 ** attempt, init.signal ?? undefined)
        continue
      }
      this.rememberCookies(url, response)
      if (response.status === 403) {
        this.blockedDiagnostic = safeDiagnostic(url, response.status)
        throw new McmodProviderError('MC百科拒绝了本次访问，已停止该平台请求', 403, this.blockedDiagnostic)
      }
      if (response.status === 429) {
        lastError = new McmodProviderError('MC百科请求过于频繁', 429, safeDiagnostic(url, response.status))
        if (attempt + 1 >= MAX_REQUEST_ATTEMPTS) throw lastError
        await delay(retryAfterMs(response.headers.get('retry-after')) ?? 1_000 * 2 ** attempt, init.signal ?? undefined)
        continue
      }
      if ([408, 425, 500, 502, 503, 504].includes(response.status) && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
        lastError = new McmodProviderError('MC百科暂时不可用', response.status, safeDiagnostic(url, response.status))
        await delay(750 * 2 ** attempt, init.signal ?? undefined)
        continue
      }
      if (!response.ok) throw new McmodProviderError(`MC百科请求失败（${response.status}）`, response.status, safeDiagnostic(url, response.status))
      return response
    }
    throw new McmodProviderError(`MC百科请求连续 ${MAX_REQUEST_ATTEMPTS} 次失败`, undefined, lastError instanceof Error ? lastError.message : String(lastError))
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function mcmodIconUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, MCMOD_SEARCH_ORIGIN)
    return url.protocol === 'https:' && ['www.mcmod.cn', 'search.mcmod.cn', 'i.mcmod.cn'].includes(url.hostname) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function parseMcmodSearchHtml(html: string, limit = 20): McmodSearchResult[] {
  const $ = load(html)
  const results: McmodSearchResult[] = []
  $('.search-result-list .result-item').each((_index, element) => {
    if (results.length >= limit) return false
    const anchor = $(element).find('.head a[href*="/class/"]').filter((_index, candidate) => /\/class\/\d+\.html/i.test($(candidate).attr('href') ?? '')).first()
    const href = anchor.attr('href') ?? ''
    const match = href.match(/\/class\/(\d+)\.html/i)
    const name = cleanText(anchor.text())
    if (!match || !name) return
    const englishName = cleanText($(element).find('.head .ename, .english-name').first().text()) || name.match(/\(([A-Za-z][A-Za-z0-9 ._':-]{1,100})\)/)?.[1]
    const iconUrl = mcmodIconUrl($(element).find('img').first().attr('src'))
    results.push({
      projectId: match[1],
      name,
      ...(englishName ? { englishName } : {}),
      summary: cleanText($(element).find('.body').text()).slice(0, 600),
      pageUrl: `${MCMOD_ORIGIN}/class/${match[1]}.html`,
      ...(iconUrl ? { iconUrl } : {})
    })
  })
  return results
}

export function parseMcmodRecommendationsHtml(html: string, limit = 12): McmodSearchResult[] {
  const $ = load(html)
  const results: McmodSearchResult[] = []
  $('.modlist-block').each((_index, element) => {
    if (results.length >= limit) return false
    const block = $(element)
    const anchor = block.find('.title .name a[href*="/class/"]').first()
    const href = anchor.attr('href') ?? ''
    const match = href.match(/\/class\/(\d+)\.html/i)
    const name = cleanText(anchor.text())
    if (!match || !name) return
    const englishName = cleanText(block.find('.title .ename a').first().text())
    const iconUrl = mcmodIconUrl(block.find('.cover img').first().attr('src'))
    results.push({
      projectId: match[1],
      name,
      summary: cleanText(block.find('.intro .intro-content').text()).slice(0, 600),
      pageUrl: `${MCMOD_ORIGIN}/class/${match[1]}.html`,
      ...(englishName ? { englishName } : {}),
      ...(iconUrl ? { iconUrl } : {})
    })
  })
  return results
}

function parseLoaderTitles(fragment: string): string[] {
  const $ = load(fragment || '', null, false)
  return [...new Set($('.download-api').map((_index, element) => $(element).attr('title') ?? $(element).text()).get().map(cleanText).filter(Boolean))]
}

function mcmodFileKey(projectId: string, fileId: string, md5: string): string {
  return createHash('sha256').update(`${projectId}:${fileId}:${md5}`).digest('hex').slice(0, 32)
}

export function parseMcmodDownloadHtml(projectId: string, html: string): ParsedDownloadPage {
  const token = html.match(/\bfile_token\s*=\s*['"]([A-Za-z0-9_-]{4,128})['"]/i)?.[1] ?? ''
  const $ = load(html)
  const files: McmodFileInfo[] = []
  const md5ByFileKey = new Map<string, string>()
  $('tr[data-id][data-md5][data-sha256][data-filename]').each((_index, element) => {
    const row = $(element)
    const fileId = row.attr('data-id') ?? ''
    const md5 = row.attr('data-md5') ?? ''
    const sha256 = row.attr('data-sha256') ?? ''
    const baseName = row.attr('data-filename') ?? ''
    const suffix = row.attr('data-suffix') ?? ''
    const filename = `${baseName}.${suffix}`
    if (!/^\d{1,12}$/.test(fileId) || !/^[a-f0-9]{32}$/i.test(md5) || !/^[a-f0-9]{64}$/i.test(sha256) || !isSafeModJarFileName(filename)) return
    const sizeTitle = row.find('td').eq(3).attr('data-original-title') ?? ''
    const size = Number(sizeTitle.match(/(\d+)\s*bytes/i)?.[1] ?? '')
    const fileKey = mcmodFileKey(projectId, fileId, md5)
    files.push({
      fileId,
      projectId,
      fileKey,
      filename,
      minecraftVersion: cleanText(row.attr('data-version') ?? row.find('.version').text()),
      loaders: parseLoaderTitles(row.attr('data-head') ?? ''),
      sha256: sha256.toLowerCase(),
      ...(Number.isSafeInteger(size) && size > 0 ? { size } : {})
    })
    md5ByFileKey.set(fileKey, md5.toLowerCase())
  })
  return { fileToken: token, files, md5ByFileKey }
}

function validateProjectId(value: string): string {
  const projectId = value.trim()
  if (!/^\d{1,12}$/.test(projectId)) throw new Error('MC百科项目 ID 无效')
  return projectId
}

function manualRequirementsPath(project: ProjectInfo): string {
  return path.join(project.path, project.toolDataDirectory ?? '.modmind', 'manual-mods.json')
}

function normalizeManualRequirement(value: unknown): McmodManualRequirement | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.request !== 'string' || typeof record.reason !== 'string' || !Array.isArray(record.matches)) return null
  const matches = record.matches.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const match = item as Record<string, unknown>
    if (typeof match.projectId !== 'string' || !/^\d{1,12}$/.test(match.projectId) || typeof match.name !== 'string' || typeof match.summary !== 'string') return []
    const iconUrl = mcmodIconUrl(typeof match.iconUrl === 'string' ? match.iconUrl : undefined)
    return [{ projectId: match.projectId, name: match.name.slice(0, 180), summary: match.summary.slice(0, 600), pageUrl: `${MCMOD_ORIGIN}/class/${match.projectId}.html`, ...(iconUrl ? { iconUrl } : {}) }]
  })
  return { request: record.request.slice(0, 180), reason: record.reason.slice(0, 500), matches }
}

export async function saveManualModRequirements(project: ProjectInfo, requirements: McmodManualRequirement[]): Promise<void> {
  const target = manualRequirementsPath(project)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(requirements, null, 2)}\n`, 'utf8')
}

export async function readManualModRequirements(project: ProjectInfo): Promise<McmodManualRequirement[]> {
  const parsed = await fs.readFile(manualRequirementsPath(project), 'utf8').then((value) => JSON.parse(value) as unknown).catch(() => [])
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((value) => {
    const normalized = normalizeManualRequirement(value)
    return normalized ? [normalized] : []
  })
}

async function clearManualRequirement(project: ProjectInfo, projectId: string): Promise<void> {
  const requirements = await readManualModRequirements(project)
  const remaining = requirements.filter((requirement) => !requirement.matches.some((match) => match.projectId === projectId))
  if (remaining.length !== requirements.length) await saveManualModRequirements(project, remaining)
}

export class McmodService {
  private readonly sessions = new Map<string, DownloadSession>()
  private readonly searchCache = new Map<string, { expiresAt: number; value: McmodSearchResult[] }>()
  private readonly filesCache = new Map<string, { expiresAt: number; value: McmodFileInfo[] }>()
  private recommendationsCache: { expiresAt: number; value: McmodSearchResult[] } | null = null

  constructor(private readonly client = new McmodHttpClient()) {}

  async search(query: string, limit = 20, signal?: AbortSignal): Promise<McmodSearchResult[]> {
    const normalized = cleanText(query).slice(0, 120)
    if (!normalized) throw new Error('请输入要查询的 Mod 名称')
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 20)
    const cacheKey = `${normalized.toLowerCase()}:${boundedLimit}`
    const cached = this.searchCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const response = await this.client.request(`${MCMOD_SEARCH_ORIGIN}/s?${new URLSearchParams({ key: normalized, mold: '0' })}`, { signal })
    const value = parseMcmodSearchHtml(await response.text(), boundedLimit)
    this.searchCache.set(cacheKey, { expiresAt: Date.now() + 10 * 60_000, value })
    return value
  }

  async recommendations(limit = 12, signal?: AbortSignal): Promise<McmodSearchResult[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 24)
    if (this.recommendationsCache && this.recommendationsCache.expiresAt > Date.now() && this.recommendationsCache.value.length >= boundedLimit) {
      return this.recommendationsCache.value.slice(0, boundedLimit)
    }
    const response = await this.client.request(`${MCMOD_ORIGIN}/modlist.html?sort=downloads`, { signal })
    const value = parseMcmodRecommendationsHtml(await response.text(), boundedLimit)
    this.recommendationsCache = { expiresAt: Date.now() + 10 * 60_000, value }
    return value
  }

  private async downloadPage(projectId: string, signal?: AbortSignal): Promise<ParsedDownloadPage> {
    const response = await this.client.request(`${MCMOD_ORIGIN}/download/${validateProjectId(projectId)}.html`, { signal })
    return parseMcmodDownloadHtml(projectId, await response.text())
  }

  async listFiles(projectId: string, signal?: AbortSignal): Promise<McmodFileInfo[]> {
    const id = validateProjectId(projectId)
    const cached = this.filesCache.get(id)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const page = await this.downloadPage(id, signal)
    this.filesCache.set(id, { expiresAt: Date.now() + 5 * 60_000, value: page.files })
    return page.files
  }

  private async captchaData(file: McmodFileInfo, signal?: AbortSignal): Promise<string> {
    const page = await this.downloadPage(file.projectId, signal)
    const current = page.files.find((candidate) => candidate.fileKey === file.fileKey)
    if (!current) throw new Error('MC百科下载文件已更新，请重新选择版本')
    const md5 = page.md5ByFileKey.get(current.fileKey)
    if (!md5) throw new Error('MC百科下载文件缺少验证码标识')
    const response = await this.client.request(`${MCMOD_ORIGIN}/frame/class/DownloadCaptcha/?${new URLSearchParams({ id: md5, r: randomUUID().replaceAll('-', '').slice(0, 8) })}`, {
      headers: { Referer: `${MCMOD_ORIGIN}/download/${file.projectId}.html` },
      signal
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('MC百科验证码图片无效')
    const mime = response.headers.get('content-type')?.split(';', 1)[0] || 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  async beginDownload(project: ProjectInfo, projectId: string, fileKey: string, signal?: AbortSignal): Promise<McmodCaptchaChallenge> {
    return this.beginSession(project, projectId, fileKey, 'modpack', signal)
  }

  async beginAddonDownload(project: ProjectInfo, projectId: string, fileKey: string, signal?: AbortSignal): Promise<McmodCaptchaChallenge> {
    if (project.kind === 'modpack' || !isJavaLoader(project.loader)) throw new Error('MC百科附属模组下载需要 Java 模组项目')
    return this.beginSession({ ...project, kind: 'modpack' } as ProjectInfo, projectId, fileKey, 'addon', signal)
  }

  private async beginSession(project: ProjectInfo, projectId: string, fileKey: string, mode: DownloadSession['mode'], signal?: AbortSignal): Promise<McmodCaptchaChallenge> {
    if (project.kind !== 'modpack') throw new Error('只有整合包项目可以下载第三方 Mod')
    if (!/^[a-f0-9]{32}$/i.test(fileKey)) throw new Error('MC百科文件标识无效')
    const page = await this.downloadPage(projectId, signal)
    const file = page.files.find((candidate) => candidate.fileKey === fileKey)
    if (!file || !page.fileToken) throw new Error('MC百科下载文件已更新，请重新选择版本')
    const captchaDataUrl = await this.captchaData(file, signal)
    const id = randomUUID()
    const session: DownloadSession = { id, projectPath: project.path, file, fileToken: page.fileToken, attempts: 0, expiresAt: Date.now() + SESSION_TTL_MS, captchaDataUrl, mode }
    this.sessions.set(id, session)
    return this.publicChallenge(session)
  }

  private requireSession(project: ProjectInfo, sessionId: string): DownloadSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.projectPath !== project.path || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId)
      throw new Error('验证码会话已过期，请重新选择文件')
    }
    return session
  }

  private publicChallenge(session: DownloadSession): McmodCaptchaChallenge {
    return { sessionId: session.id, file: session.file, captchaDataUrl: session.captchaDataUrl, attemptsRemaining: Math.max(0, 3 - session.attempts), expiresAt: new Date(session.expiresAt).toISOString() }
  }

  async refreshCaptcha(project: ProjectInfo, sessionId: string, signal?: AbortSignal): Promise<McmodCaptchaChallenge> {
    const session = this.requireSession(project, sessionId)
    session.captchaDataUrl = await this.captchaData(session.file, signal)
    return this.publicChallenge(session)
  }

  async submitCaptcha(project: ProjectInfo, sessionId: string, captcha: string, signal?: AbortSignal): Promise<McmodDownloadResult> {
    const session = this.requireSession(project, sessionId)
    const value = captcha.trim()
    if (!value || value.length > 8 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('请输入图片中的验证码')
    const response = await this.client.request(`${MCMOD_ORIGIN}/action/doDownload/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: `${MCMOD_ORIGIN}/download/${session.file.projectId}.html`
      },
      body: new URLSearchParams({ data: JSON.stringify({ todo: 'download', file: await this.resolveMd5(session.file, signal), token: session.fileToken, line: 'a', captcha: value }) }),
      signal
    })
    const payload = await response.json().catch(() => null) as { state?: unknown; url?: unknown } | null
    if (!payload || Number(payload.state) !== 0 || typeof payload.url !== 'string') {
      session.attempts += 1
      const attemptsRemaining = Math.max(0, 3 - session.attempts)
      if (!attemptsRemaining) {
        this.sessions.delete(session.id)
        return { success: false, message: '验证码连续三次未通过，请重新开始下载', attemptsRemaining: 0 }
      }
      session.captchaDataUrl = await this.captchaData(session.file, signal)
      return { success: false, message: `验证码未通过（平台状态 ${String(payload?.state ?? 'unknown')}）`, attemptsRemaining, captchaDataUrl: session.captchaDataUrl }
    }
    const url = new URL(payload.url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('MC百科返回了不受信任的下载地址')
    if (session.mode === 'addon') {
      const filePath = await this.downloadAddonVerified(project, session.file, url.toString(), signal)
      this.sessions.delete(session.id)
      return { success: true, message: `${session.file.filename} 已校验并暂存，等待加入附属关系`, attemptsRemaining: 3 - session.attempts, fileName: session.file.filename, sha256: session.file.sha256, filePath }
    }
    const installed = await this.installVerified(project, session.file, url.toString(), signal)
    this.sessions.delete(session.id)
    return { success: true, message: `${installed.fileName} 已校验并加入整合包`, attemptsRemaining: 3 - session.attempts, fileName: installed.fileName, sha256: installed.sha256 }
  }

  private async resolveMd5(file: McmodFileInfo, signal?: AbortSignal): Promise<string> {
    const page = await this.downloadPage(file.projectId, signal)
    const md5 = page.md5ByFileKey.get(file.fileKey) ?? ''
    if (!/^[a-f0-9]{32}$/i.test(md5)) throw new Error('MC百科下载文件已更新，请重新选择版本')
    return md5
  }

  private async installVerified(project: ProjectInfo, file: McmodFileInfo, downloadUrl: string, signal?: AbortSignal): Promise<{ fileName: string; sha256: string }> {
    return withProjectMutation(project.path, () => this.installVerifiedUnlocked(project, file, downloadUrl, signal))
  }

  private async installVerifiedUnlocked(project: ProjectInfo, file: McmodFileInfo, downloadUrl: string, signal?: AbortSignal): Promise<{ fileName: string; sha256: string }> {
    const targetName = file.filename
    if (!isSafeModJarFileName(targetName)) throw new Error('MC百科返回了不安全的文件名')
    const stagingRoot = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'mcmod-downloads', randomUUID())
    const staged = path.join(stagingRoot, targetName)
    const backup = path.join(stagingRoot, `${targetName}.backup`)
    await assertContentTarget(project.path, stagingRoot)
    const originalManifest = await readModpackManifest(project)
    const modsRoot = modpackModsRoot(project, originalManifest)
    const target = path.join(modsRoot, targetName)
    await assertContentTarget(project.path, target)
    const originalLock = await readModpackLock(project)
    let backedUp = false
    let committed = false
    let recoveryFailed = false
    try {
      await fs.mkdir(stagingRoot, { recursive: true })
      const result = await verifiedDownload.download({ sources: [{ id: 'mcmod-user-download', label: 'MC百科用户下载', url: downloadUrl }], destination: staged, expectedHash: { algorithm: 'sha256', value: file.sha256 }, maxBytes: 256 * 1024 * 1024, signal })
      if (result.bytes < 1_024) throw new Error('下载文件过小，不是有效的 Mod JAR')
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) {
        await fs.rename(target, backup)
        backedUp = true
      }
      await fs.rename(staged, target)
      committed = true
      const previous = originalLock.mods.find((mod) => mod.provider === 'mcmod' && mod.projectId === file.projectId)
      const obsoleteName = previous?.fileName
      const manifestEntry = { fileName: targetName, sha256: file.sha256, size: result.bytes, addedAt: new Date().toISOString() }
      await writeModpackManifest(project, {
        ...originalManifest,
        mods: [...originalManifest.mods.filter((mod) => mod.fileName.toLowerCase() !== targetName.toLowerCase() && mod.fileName !== obsoleteName), manifestEntry].sort((left, right) => left.fileName.localeCompare(right.fileName))
      })
      const locked: LockedMod = {
        provider: 'mcmod',
        projectId: file.projectId,
        versionId: file.fileId,
        versionName: file.minecraftVersion || file.fileId,
        fileName: targetName,
        sha256: file.sha256,
        size: result.bytes,
        side: 'unknown',
        sources: [`${MCMOD_ORIGIN}/download/${file.projectId}.html`],
        installedAt: new Date().toISOString()
      }
      await writeModpackLock(project, {
        ...originalLock,
        mods: [...originalLock.mods.filter((mod) => !(mod.provider === 'mcmod' && mod.projectId === file.projectId) && mod.fileName.toLowerCase() !== targetName.toLowerCase()), locked].sort((left, right) => left.fileName.localeCompare(right.fileName))
      })
      const audit = await auditModpackLock(project)
      if (!audit.success) throw new Error(`锁定审计失败：${audit.errors.join('；')}`)
      if (obsoleteName && obsoleteName !== targetName) await fs.rm(path.join(modsRoot, obsoleteName), { force: true })
      await clearManualRequirement(project, file.projectId)
      return { fileName: targetName, sha256: file.sha256 }
    } catch (error) {
      const recoveryErrors: unknown[] = []
      if (committed) await fs.rm(target, { force: true }).catch(value => recoveryErrors.push(value))
      if (backedUp) await fs.rename(backup, target).catch(value => recoveryErrors.push(value))
      if (committed) {
        await writeModpackManifest(project, originalManifest).catch(value => recoveryErrors.push(value))
        await writeModpackLock(project, originalLock).catch(value => recoveryErrors.push(value))
      }
      if (recoveryErrors.length) {
        recoveryFailed = true
        throw new AggregateError([error, ...recoveryErrors], `下载失败且自动恢复未完成，恢复文件保留在 ${stagingRoot}`)
      }
      throw error
    } finally {
      if (!recoveryFailed) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async downloadAddonVerified(project: ProjectInfo, file: McmodFileInfo, downloadUrl: string, signal?: AbortSignal): Promise<string> {
    if (!isSafeModJarFileName(file.filename)) throw new Error('MC百科返回了不安全的文件名')
    const root = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'mcmod-addon-staging', randomUUID())
    const target = path.join(root, file.filename)
    await assertContentTarget(project.path, target)
    await fs.mkdir(root, { recursive: true })
    try {
      const result = await verifiedDownload.download({ sources: [{ id: 'mcmod-user-download', label: 'MC百科用户下载', url: downloadUrl }], destination: target, expectedHash: { algorithm: 'sha256', value: file.sha256 }, maxBytes: 256 * 1024 * 1024, signal })
      if (result.bytes < 1_024) throw new Error('下载文件过小，不是有效的 Mod JAR')
      return target
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}
