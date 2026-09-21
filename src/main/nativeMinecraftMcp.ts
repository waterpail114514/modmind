import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import catalog from './nativeMinecraftMcpCatalog.json'
import screenshotHelper from './nativeMinecraftMcpHelper.json'
import { verifiedDownload } from './downloadService'
import { archiveFileInfo, archiveRead } from './ftbResourceArchive'
import { createStoredZip } from './bedrockAddon'

export function nativeMcpFor(minecraft: string, loader: string) {
  return catalog.entries.find(entry => entry.minecraft === minecraft && entry.loader === loader)
}
export const nativeMcpRelease = catalog.release

/** Change only an exact CONSTANT_Utf8 entry; never replace arbitrary class bytes. */
export function restrictMcpServerAddress(bytes: Buffer): Buffer {
  if (bytes.readUInt32BE(0) !== 0xcafebabe) throw new Error('MCP 控制插件 class 格式无效')
  const parts = [bytes.subarray(0, 10)]
  let offset = 10; let changed = 0
  for (let index = 1; index < bytes.readUInt16BE(8); index++) {
    const start = offset; const tag = bytes[offset++]
    if (tag === 1) {
      const length = bytes.readUInt16BE(offset); offset += 2
      if (offset + length > bytes.length) throw new Error('MCP 控制插件 class 已截断')
      const value = bytes.subarray(offset, offset + length).toString('utf8'); offset += length
      if (value === '0.0.0.0') {
        const replacement = Buffer.from('127.0.0.1'); const header = Buffer.alloc(3)
        header[0] = 1; header.writeUInt16BE(replacement.length, 1)
        parts.push(header, replacement); changed++
        continue
      }
    } else {
      const size = ({ 3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 } as Record<number, number>)[tag]
      if (!size) throw new Error(`不支持的 class 常量类型 ${tag}`)
      offset += size
      if (tag === 5 || tag === 6) index++
    }
    if (offset > bytes.length) throw new Error('MCP 控制插件 class 已截断')
    parts.push(bytes.subarray(start, offset))
  }
  if (changed !== 1) throw new Error('MCP 上游监听地址与已审核版本不一致')
  return Buffer.concat([...parts, bytes.subarray(offset)])
}

export async function prepareLocalMcpJar(source: string): Promise<Buffer> {
  const entries = await archiveFileInfo(source)
  const serverClass = 'xyz/langyo/minecraft/mcp/common/McpHttpServer.class'
  if (!entries.some(entry => entry.path === serverClass) || entries.some(entry => /^META-INF\/.*\.(SF|RSA|DSA|EC)$/i.test(entry.path))) {
    throw new Error('MCP 发布包布局或签名发生变化，不能应用本机监听补丁')
  }
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > 32 * 1024 * 1024) throw new Error('MCP 发布包解压内容过大')
  const files = []
  const replacements = new Map(screenshotHelper.classes.map(helper => {
    const bytes = Buffer.from(helper.data, 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== helper.classSha256) throw new Error('MCP 截图适配器校验失败')
    return [helper.path, bytes]
  }))
  for (const entry of entries) {
    const data = await archiveRead(source, entry.path)
    files.push({ name: entry.path, data: entry.path === serverClass ? restrictMcpServerAddress(data)
      : replacements.get(entry.path) ?? data })
  }
  files.push({ name: 'META-INF/modmind-integration.txt', data: Buffer.from(`ModMind integration of langyo/minecraft-mod-mcp ${catalog.release}.\nModified McpHttpServer.class: bind to 127.0.0.1 instead of 0.0.0.0.\nUpstream: ${catalog.source}\n`) })
  files.push({ name: 'META-INF/modmind-minecraft-mcp-LICENSE.txt', data: Buffer.from(catalog.license) })
  files.push({ name: 'META-INF/modmind-screenshot-adapter.txt', data: Buffer.from('ScreenshotHelper.class is replaced by the ModMind native framebuffer adapter (AGPL-3.0-only). WindowHelper.class is adapted from upstream (MIT) to query actual framebuffer dimensions. Source: resources/minecraft-mcp/ in https://github.com/waterpail114514/modmind.\n') })
  return createStoredZip(files, true)
}

export async function installNativeMcp(entry: NonNullable<ReturnType<typeof nativeMcpFor>>, mods: string, signal?: AbortSignal): Promise<void> {
  const cache = path.join(app.getPath('userData'), 'test-tools', 'minecraft-mod-mcp', `${entry.sha256}.jar`)
  const valid = await fs.readFile(cache).then(bytes => createHash('sha256').update(bytes).digest('hex') === entry.sha256).catch(() => false)
  if (!valid) await verifiedDownload.download({
    sources: [{ id: 'minecraft-mod-mcp', label: 'Minecraft Mod MCP', url: entry.url }, { id: 'minecraft-mod-mcp-mirror', label: 'Minecraft Mod MCP 镜像', url: `https://ghfast.top/${entry.url}` }],
    destination: cache, expectedHash: { algorithm: 'sha256', value: entry.sha256 }, maxBytes: 16 * 1024 * 1024, signal
  })
  signal?.throwIfAborted()
  const bytes = await prepareLocalMcpJar(cache)
  signal?.throwIfAborted()
  await fs.mkdir(mods, { recursive: true })
  await fs.writeFile(path.join(mods, 'modmind-minecraft-mcp.jar'), bytes, { flag: 'wx' })
}

export class NativeMinecraftMcpClient {
  constructor(private readonly port: number, private readonly pid: number, private readonly isRunning: () => boolean) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(pid) || pid <= 0) throw new Error('MCP 进程或端口无效')
  }
  private async request(endpoint: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.isRunning()) throw new Error('测试客户端已退出')
    const timeout = AbortSignal.timeout(15_000)
    const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Minecraft MCP HTTP ${response.status}`) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Minecraft MCP 返回空响应')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 24 * 1024 * 1024) throw new Error('Minecraft MCP 响应过大')
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Minecraft MCP 响应格式无效')
    const value = result as Record<string, unknown>
    if (value.error || value.success === false || value.ok === false) throw new Error(`Minecraft MCP：${String(value.error ?? value.message ?? '操作失败')}`)
    if (typeof value.result === 'string' && /^(error:|unknown:|missing |failed|not in control)/i.test(value.result)) throw new Error(`Minecraft MCP：${value.result}`)
    return value
  }
  async verify(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const status = await this.request('/api/status', undefined, signal)
    if (status.type !== 'minecraft-mod' || status.pid !== this.pid || status.port !== this.port) throw new Error('MCP 进程身份不匹配，不会连接其他游戏实例')
    return status
  }
  async command(command: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.verify(signal)
    return this.request('/api/cmd', { ...params, cmd: command }, signal)
  }
  async capture(directory: string, signal?: AbortSignal) {
    await this.verify(signal)
    const response = await this.request('/api/screenshot', undefined, signal)
    const match = typeof response.original === 'string' && /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(response.original)
    if (!match) throw new Error('MCP 没有返回原生 PNG 截图')
    const bytes = Buffer.from(match[1], 'base64')
    if (bytes.length > 8 * 1024 * 1024) throw new Error('截图过大')
    const sharp = (await import('sharp')).default
    const picture = sharp(bytes, { limitInputPixels: 16_777_216 })
    const metadata = await picture.metadata()
    if (metadata.format !== 'png') throw new Error('截图不是 PNG')
    const stats = await picture.stats()
    if (stats.channels.slice(0, 3).every(channel => channel.stdev < 1)) throw new Error('截图为空白或单色，不能作为视觉证据')
    signal?.throwIfAborted()
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, `${randomUUID()}.png`)
    await fs.writeFile(file, bytes, { flag: 'wx' })
    return { path: file, dataUrl: response.original as string, width: metadata.width, height: metadata.height, createdAt: new Date().toISOString() }
  }
}
