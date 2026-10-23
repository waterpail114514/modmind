import fs from 'node:fs'
import path from 'node:path'

export function packKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff-]{0,127}$/.test(value)
    || value.includes('..')) throw new Error('数据包名称无效，请重新选择数据包')
  return value
}

// All generated data stays in the current project, including existing junctions/hard links.
export function projectDataPath(project, relative = '') {
  if (!project || !path.isAbsolute(project)) throw new Error('请先打开项目')
  const parts = ['.modmind', 'mc-capture', ...relative.split('/').filter(Boolean)]
  let current = fs.realpathSync(project)
  for (const part of parts) {
    if (part === '.' || part === '..' || /[\\/:\0\r\n]/.test(part)) throw new Error('采集数据路径无效')
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error('采集数据路径包含链接，请改用项目内的普通目录和文件')
  }
  return current
}

export function selectedData(project) {
  const active = projectDataPath(project, 'active.txt')
  let key
  try { key = fs.readFileSync(active, 'utf8').trim() } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error('当前项目还没有采集数据，请先在「游戏数据采集」中选择本地游戏实例并采集，再返回预览')
  }
  packKey(key)
  return projectDataPath(project, `packs/${key}`)
}
