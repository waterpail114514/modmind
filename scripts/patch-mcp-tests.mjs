import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// The pinned upstream tests split stdout chunks as messages. Keep their
// assertions, but frame JSON by newline and cover image results as well.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const patch = (await readFile(path.join(root, 'scripts/mcp-test-framing.patch'), 'utf8')).replaceAll('\r\n', '\n')
const apply = flags => spawnSync('git', ['-C', path.join(root, 'modmind-mcp-open-source'),
  'apply', '--ignore-space-change', ...flags, '-'], { input: patch, encoding: 'utf8', windowsHide: true })
if (apply(['--reverse', '--check']).status === 0) {
  console.log('MCP test framing patch already applied')
} else {
  const check = apply(['--check'])
  if (check.status !== 0) throw new Error(`Pinned MCP tests differ from the supported patch: ${check.stderr}`)
  const result = apply([])
  if (result.status !== 0) throw new Error(`Unable to patch MCP test framing: ${result.stderr}`)
  console.log('Applied MCP test framing and image regression patch')
}
