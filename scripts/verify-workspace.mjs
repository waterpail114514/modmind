import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mcpTestSource } from './mcp-test-source.mjs'

export async function verifyMcpTests(root) {
  const directory = path.join(root, 'modmind-mcp-open-source')
  const stat = await fs.lstat(directory).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MCP tests need an independent checkout. Run npm run setup:tests.')
  }
  let revision
  try {
    const top = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (await fs.realpath(top) !== await fs.realpath(directory)) throw new Error('Not an independent repository')
    revision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    await fs.access(path.join(directory, 'package.json'))
  } catch {
    throw new Error('MCP test checkout is incomplete. Run npm run setup:tests.')
  }
  if (revision !== mcpTestSource.revision) throw new Error(`MCP tests must use ${mcpTestSource.revision}; current revision is ${revision}. Preserve local changes before changing the checkout.`)
  return revision
}

export async function verifyWorkspace(root, { mcp = false } = {}) {
  const modules = path.join(root, 'node_modules')
  const stat = await fs.lstat(modules).catch(() => null)
  if (stat?.isSymbolicLink()) throw new Error('Shared node_modules link detected. Remove only the link, preserve its target, then run npm ci in this workspace.')
  if (!stat?.isDirectory()) throw new Error('Dependencies are missing. Run npm ci in this workspace.')
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.devDependencies })) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version
    const actual = await fs.readFile(path.join(modules, name, 'package.json'), 'utf8').then(text => JSON.parse(text).version).catch(() => null)
    if (!expected || actual !== expected) throw new Error(`Dependency ${name} differs from package-lock.json (${actual ?? 'missing'} vs ${expected ?? 'missing'}). Run npm ci.`)
  }
  if (mcp) await verifyMcpTests(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyWorkspace(path.resolve(import.meta.dirname, '..'), { mcp: process.argv.includes('--mcp') })
  console.log('Workspace dependencies verified' + (process.argv.includes('--mcp') ? '; pinned MCP tests ready' : ''))
}
