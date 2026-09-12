import { getNetworkProxyUrl } from './networkRequest'
import { mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function windowsSocketDirectory(base: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return ''
  try {
    const directory = path.join(base.LOCALAPPDATA || os.tmpdir(), 'ModMind', 'java-sockets')
    mkdirSync(directory, { recursive: true })
    return `-Djdk.net.unixdomain.tmpdir="${realpathSync.native(directory)}"`
  } catch { return '' }
}

export function javaProxyOptions(proxyUrl: string): string {
  if (!proxyUrl.trim()) return ''
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`)
    if (!parsed.hostname) return ''
    const host = parsed.hostname
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    if (parsed.protocol.startsWith('socks')) return `-DsocksProxyHost=${host} -DsocksProxyPort=${port}`
    return `-Dhttps.proxyHost=${host} -Dhttps.proxyPort=${port} -Dhttp.proxyHost=${host} -Dhttp.proxyPort=${port} -Dhttp.nonProxyHosts=localhost|127.*|[::1]`
  } catch { return '' }
}

export function managedJavaEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const proxy = javaProxyOptions(getNetworkProxyUrl())
  const socketDirectory = base.JAVA_TOOL_OPTIONS?.includes('jdk.net.unixdomain.tmpdir') ? '' : windowsSocketDirectory(base)
  const previous = base.JAVA_TOOL_OPTIONS?.trim() ?? ''
  const options = [previous, proxy && !previous.includes(proxy) ? proxy : '', socketDirectory].filter(Boolean).join(' ')
  return { ...base, ...(options ? { JAVA_TOOL_OPTIONS: options } : {}) }
}
