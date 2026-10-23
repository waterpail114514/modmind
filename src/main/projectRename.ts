import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

export interface ProjectRenameFilesResult {
  changedFiles: string[]
}

interface ProjectEntry {
  relative: string
  type: 'file' | 'directory'
}

const textExtensions = /\.(?:java|kt|kts|gradle|groovy|json|mcmeta|md|txt|toml|html?|xml|ya?ml|js|jsx|mjs|ts|tsx|py|lang|mcfunction|css|scss|properties|bat|cmd|sh|gitignore)$/i

function isIgnoredDirectory(name: string): boolean {
  return new Set(['.git', '.modmind', 'node_modules', 'build', '.gradle']).has(name)
}

async function collectEntries(root: string): Promise<ProjectEntry[]> {
  const entries: ProjectEntry[] = []
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true })
    for (const child of children) {
      if (child.isSymbolicLink() || (child.isDirectory() && isIgnoredDirectory(child.name))) continue
      const relative = path.relative(root, path.join(directory, child.name)).replaceAll('\\', '/')
      if (child.isDirectory()) {
        entries.push({ relative, type: 'directory' })
        await visit(path.join(directory, child.name))
      } else if (child.isFile()) {
        entries.push({ relative, type: 'file' })
      }
    }
  }
  await visit(root)
  return entries
}

function replaceIdentifier(text: string, previous: string, next: string): string {
  if (!previous || previous === next) return text
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![A-Za-z0-9_$-])${escaped}(?![A-Za-z0-9_$-])`, 'g'), () => next)
}

function renamedPath(relative: string, previousNamespace: string, nextNamespace: string): string {
  return relative.split('/').map(segment => replaceIdentifier(segment, previousNamespace, nextNamespace)).join('/')
}

function isBinary(content: Buffer): boolean {
  return content.indexOf(0) !== -1
}

/**
 * Rewrites project-owned references and path segments for a namespace change.
 * Tool state and generated build outputs are deliberately outside this tree.
 */
export async function renameProjectFiles(
  project: ProjectInfo,
  nextProject: ProjectInfo,
  manifestNames: readonly string[] = ['modmind.project.json']
): Promise<ProjectRenameFilesResult> {
  const root = path.resolve(project.path)
  const entries = await collectEntries(root)
  const manifestSet = new Set(manifestNames)
  const moves = entries
    .filter(entry => !manifestSet.has(entry.relative))
    .map((entry) => ({ ...entry, target: renamedPath(entry.relative, project.namespace, nextProject.namespace) }))
    .filter((entry) => entry.relative !== entry.target)

  const allPaths = new Set(entries.map((entry) => entry.relative))
  const moveSources = new Set(moves.map((entry) => entry.relative))
  const targets = new Set<string>()
  for (const move of moves) {
    if (targets.has(move.target)) throw new Error(`命名空间重命名产生重复路径：${move.target}`)
    targets.add(move.target)
    if (allPaths.has(move.target) && !moveSources.has(move.target)) {
      throw new Error(`命名空间重命名会覆盖现有路径：${move.target}`)
    }
  }

  const contents = new Map<string, Buffer>()
  for (const entry of entries) {
    if (entry.type !== 'file' || manifestSet.has(entry.relative)) continue
    const content = await fs.readFile(path.join(root, ...entry.relative.split('/')))
    if (!isBinary(content) && textExtensions.test(entry.relative)) contents.set(entry.relative, content)
  }

  const staging = path.join(root, `.modmind-rename-${process.pid}-${Date.now()}`)
  await fs.mkdir(staging)
  const staged = new Map<string, string>()
  const journal: Array<{ source: string; destination: string }> = []
  const changedContents: Array<{ target: string; original: Buffer }> = []
  let preserveRecovery = false
  try {
    // A failed recovery must still leave a persistent copy of the original text.
    await fs.writeFile(path.join(staging, 'original-text.json'), JSON.stringify([...contents].map(([relative, content]) => ({ relative, base64: content.toString('base64') }))))
    // Stage changed entries first so directory moves cannot invalidate a child source path.
    for (const [index, move] of [...moves].sort((left, right) => right.relative.split('/').length - left.relative.split('/').length).entries()) {
      const source = path.join(root, ...move.relative.split('/'))
      const temporary = path.join(staging, String(index))
      await fs.rename(source, temporary)
      journal.push({ source, destination: temporary })
      staged.set(move.relative, temporary)
    }

    // Recreate the destination tree with directories before files.
    for (const move of [...moves].sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.target.split('/').length - right.target.split('/').length
    })) {
      const temporary = staged.get(move.relative)
      if (!temporary) continue
      const destination = path.join(root, ...move.target.split('/'))
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.rename(temporary, destination)
      journal.push({ source: temporary, destination })
    }

    const changedFiles: string[] = []
    for (const entry of entries) {
      if (entry.type !== 'file' || manifestSet.has(entry.relative)) continue
      const original = contents.get(entry.relative)
      if (!original) continue
      const previous = original.toString('utf8')
      const next = replaceIdentifier(replaceIdentifier(previous, project.namespace, nextProject.namespace), project.name, nextProject.name)
      if (next === previous) continue
      const targetRelative = renamedPath(entry.relative, project.namespace, nextProject.namespace)
      const target = path.join(root, ...targetRelative.split('/'))
      changedContents.push({ target, original })
      await fs.writeFile(target, next, 'utf8')
      changedFiles.push(targetRelative)
    }
    changedFiles.push(...moves.filter((entry) => entry.type === 'file').map((entry) => entry.target))
    return { changedFiles: [...new Set(changedFiles)].sort() }
  } catch (error) {
    const failures: unknown[] = []
    for (const change of changedContents.reverse()) {
      try { await fs.writeFile(change.target, change.original) } catch (failure) { failures.push(failure) }
    }
    for (const move of journal.reverse()) {
      try { await fs.mkdir(path.dirname(move.source), { recursive: true }); await fs.rename(move.destination, move.source) }
      catch (failure) { failures.push(failure) }
    }
    if (failures.length) {
      preserveRecovery = true
      await fs.writeFile(path.join(staging, 'recovery.json'), JSON.stringify({ journal, failed: failures.map(String) }, null, 2)).catch(() => undefined)
      throw new AggregateError([error, ...failures], `项目重命名未能完全恢复，原文件和恢复记录保留在：${staging}`)
    }
    throw error
  } finally {
    if (!preserveRecovery) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
