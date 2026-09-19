import { promises as fs } from 'node:fs'
import path from 'node:path'
import { net, protocol } from 'electron'
import { PLUGIN_PROTOCOL_SCHEME, type PluginRecord } from '../shared/plugins'

export const PLUGIN_PANEL_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export interface PluginProtocolDeps {
  getPlugin(id: string): PluginRecord | undefined
}

function resolveInsidePlugin(record: PluginRecord, relativePath: string): string | null {
  return resolvePluginRequestPath(record, relativePath)
}

/** 纯函数：把请求路径解析为插件目录内的绝对路径；越界/非法时返回 null。 */
export function resolvePluginRequestPath(record: PluginRecord, relativePath: string): string | null {
  const pluginRoot = path.resolve(record.directory)
  const decoded = decodeURIComponent(relativePath).replaceAll('\\', '/').replace(/^\/+/, '')
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '..') return null
  }
  if (!decoded) return null
  const resolved = path.resolve(pluginRoot, decoded)
  if (resolved !== pluginRoot && !resolved.startsWith(pluginRoot + path.sep)) return null
  return resolved
}

/**
 * 注册 modmind-plugin:// 协议。
 * URL 形态: modmind-plugin://<pluginId>/<relativePath>
 * 必须在 app.ready 之前调用 registerPluginProtocolScheme()，ready 之后调用本函数。
 */
export function registerPluginProtocol(deps: PluginProtocolDeps): void {
  protocol.handle(PLUGIN_PROTOCOL_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // host 部分是插件 id（URL 解析会小写化，恰好与插件 id 约定一致）
      const pluginId = url.hostname
      const record = deps.getPlugin(pluginId)
      if (!record || !record.enabled) {
        return new Response(`插件不存在或已停用：${pluginId}`, { status: 404 })
      }
      let relativePath = url.pathname.replace(/^\/+/, '')
      if (!relativePath) relativePath = record.manifest.panel?.entry ?? record.manifest.overlay?.entry ?? ''
      if (!relativePath || (!record.manifest.panel && !record.manifest.overlay && relativePath !== record.manifest.icon)) {
        return new Response('插件没有可用面板资源', { status: 404 })
      }

      const filePath = resolveInsidePlugin(record, relativePath)
      if (!filePath) return new Response('非法路径', { status: 400 })

      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat?.isFile()) return new Response('文件不存在', { status: 404 })

      const data = await fs.readFile(filePath)
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Security-Policy': PLUGIN_PANEL_CSP,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch (error) {
      return new Response(`插件资源加载失败：${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  })
}

/** scheme 特权注册，必须在 app.ready 前调用一次。 */
export function registerPluginProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'modmind-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
    {
      scheme: PLUGIN_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
    }
  ])
}

// 引用 net 以保持导入（部分 Electron 版本需要先加载 net 模块才能在协议处理器中使用 Response）
void net
