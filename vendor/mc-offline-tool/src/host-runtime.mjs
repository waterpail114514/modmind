import path from 'node:path'
import fs from 'node:fs'
import { packKey, projectDataPath } from './project-data.mjs'

export function bindProjectRuntime(core) {
  const actions = {}
  for (const [name, handler] of Object.entries(core)) {
    if (typeof handler !== 'function' || name.startsWith('__')) continue
    actions[name] = async (input, context = {}) => {
      context.signal?.throwIfAborted()
      const projectPath = context.projectPath
      if (!projectPath || !path.isAbsolute(projectPath)) throw new Error('请先打开项目')
      if (input.projectPath && path.resolve(input.projectPath).toLowerCase() !== path.resolve(projectPath).toLowerCase()) {
        throw new Error('项目已经切换，请重新操作')
      }
      if (input.outDir) throw new Error('采集结果只能保存到当前项目')
      projectDataPath(projectPath)
      projectDataPath(projectPath, 'active.txt')
      for (const file of ['import-progress.json', 'import-cancel.txt']) projectDataPath(projectPath, file)
      if (input.key) projectDataPath(projectPath, `packs/${packKey(input.key)}/icons`)
      // Reject links in existing package roots before a capture/select/clear operation.
      const packs = projectDataPath(projectPath, 'packs')
      if (fs.existsSync(packs)) for (const entry of fs.readdirSync(packs, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          for (const leaf of ['', '/icons', '/items.json', '/meta.json']) projectDataPath(projectPath, `packs/${packKey(entry.name)}${leaf}`)
        }
      }
      return handler({ ...input, projectPath }, context)
    }
  }
  return { actions }
}
