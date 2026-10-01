import { createHash } from 'node:crypto'
import { readFileSync, statSync, chmodSync } from 'node:fs'
import path from 'node:path'

export function activate(options: { pluginDirectory: string }) {
  const root = path.join(options.pluginDirectory, 'assets', 'native')
  const metadata = JSON.parse(readFileSync(path.join(root, 'binaries.json'), 'utf8')) as { platform: string; arch: string; binaries: Record<string, { file: string; sha256: string }> }
  if (metadata.platform !== process.platform || metadata.arch !== process.arch) throw new Error('媒体处理支持与当前操作系统或架构不兼容')
  const verifiedFiles = new Map<string, { size: number; mtimeMs: number; ctimeMs: number }>()
  const executable = (name = 'ffmpeg'): string => {
    const entry = metadata.binaries[name]
    if (!entry || !/^[a-z0-9_.-]+$/i.test(entry.file) || path.basename(entry.file) !== entry.file) throw new Error('媒体工具不存在')
    const binary = path.join(root, entry.file), stat = statSync(binary)
    const checked = verifiedFiles.get(name)
    if (!checked || stat.size !== checked.size || stat.mtimeMs !== checked.mtimeMs || stat.ctimeMs !== checked.ctimeMs) {
      if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== entry.sha256) throw new Error('媒体工具校验失败，请重新安装媒体处理支持')
      if (process.platform !== 'win32') chmodSync(binary, 0o755)
      const verified = statSync(binary)
      verifiedFiles.set(name, { size: verified.size, mtimeMs: verified.mtimeMs, ctimeMs: verified.ctimeMs })
    }
    return binary
  }
  return { executable }
}
