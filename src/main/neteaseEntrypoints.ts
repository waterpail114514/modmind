import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Static inspection only: never import or execute project Python. */
export async function inspectNeteaseEntrypoints(root: string): Promise<string[]> {
  const logs: string[] = []
  const candidates: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '__pycache__') continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.name === 'modMain.py') candidates.push(target)
    }
  }
  await visit(root).catch(error => logs.push(`FAIL  behavior_pack: ${String(error)}`))
  if (!candidates.length) return [...logs, 'FAIL  未找到 modMain.py 入口']
  for (const file of candidates) {
    const source = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')
    if (!/@Mod\.Binding\s*\(/.test(source)) { logs.push(`FAIL  ${path.relative(root, file)} 缺少 Mod.Binding`); continue }
    const constants = new Map<string, string>()
    for (const match of source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*[uUbB]?(["'])([^\r\n]*?)\2\s*(?:#.*)?$/gm)) constants.set(match[1], match[3])
    const calls = [...source.matchAll(/\bRegisterSystem\s*\(\s*([^,\n]+),\s*([^,\n]+),\s*([^\)]+)\)/g)]
    if (!calls.length) logs.push(`FAIL  ${path.relative(root, file)} 缺少 RegisterSystem`)
    for (const call of calls) {
      const expression = call[3].trim()
      const literal = /^[uUbB]?(["'])([^"']+)\1$/.exec(expression)
      const registered = literal?.[2] ?? constants.get(expression)
      if (!registered || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,}$/.test(registered)) {
        logs.push(`FAIL  ${path.relative(root, file)} 无法静态解析注册路径 ${expression}；请使用字符串或模块级字符串常量`)
        continue
      }
      const parts = registered.split('.')
      const className = parts.pop()!
      const target = path.join(root, ...parts) + '.py'
      const real = await fs.realpath(target).catch(() => '')
      const realRoot = await fs.realpath(root)
      if (!real || !real.startsWith(realRoot + path.sep)) { logs.push(`FAIL  注册路径 ${registered} 的文件缺失或越出行为包`); continue }
      const body = await fs.readFile(real, 'utf8')
      logs.push(`${new RegExp(`^\\s*class\\s+${className}\\s*[:(]`, 'm').test(body) ? 'PASS' : 'FAIL'}  注册 ${registered} → ${path.relative(root, target)}`)
    }
  }
  return logs
}
