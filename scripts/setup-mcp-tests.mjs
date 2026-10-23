import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mcpTestSource } from './mcp-test-source.mjs'
import { verifyMcpTests } from './verify-workspace.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = path.join(root, 'modmind-mcp-open-source')
// Never reset, overwrite or relink an existing checkout.
if (!await fs.lstat(directory).catch(() => null)) {
  const options = { windowsHide: true, stdio: 'inherit' }
  execFileSync('git', ['clone', '--no-checkout', mcpTestSource.url, directory], options)
  execFileSync('git', ['-C', directory, 'checkout', '--detach', mcpTestSource.revision], options)
}
await verifyMcpTests(root)
console.log(`MCP tests ready at ${mcpTestSource.revision}`)
