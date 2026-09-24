import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { agentProtectionConfigArgs, assertAgentProjectAllowed, assertAgentWriteAllowed, configureAgentProtection } from './agentProtection'
import { codexApprovalPolicy } from '../shared/agentApproval'

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-protection-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  configureAgentProtection([])
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('agent infrastructure protection', () => {
  it('allows source changes and rejects internal paths, traversal, and Windows aliases', async () => {
    const root = await fixture()
    expect(() => assertAgentWriteAllowed(root, 'src/Main.java')).not.toThrow()
    for (const file of ['.modmind/session.json', '.MODMIND/x', 'nested/.modmind/x', '.modmind./x', '.modmind /x', '../outside', 'src/../../outside', 'C:\\ModMind\\app.exe', 'src/file:stream', '']) {
      expect(() => assertAgentWriteAllowed(root, file), file).toThrow()
    }
  })

  it('rejects coding projects inside the installation and real user data, even under another name', async () => {
    const root = await fixture()
    const install = path.join(root, 'application')
    const userData = path.join(root, 'custom-data')
    configureAgentProtection([install, userData])
    for (const folder of [install, path.join(install, 'resources'), userData, path.join(root, '.modmind', 'sessions')]) {
      expect(() => assertAgentProjectAllowed(folder)).toThrow()
    }
    expect(() => assertAgentProjectAllowed(path.join(root, 'application-project'))).not.toThrow()
    expect(() => assertAgentWriteAllowed(root, 'custom-data/settings.json')).toThrow()
    expect(agentProtectionConfigArgs(root).join(' ')).toContain(JSON.stringify(userData))
  })

  it('rejects linked directories and hard-linked leaf files', async () => {
    const root = await fixture()
    const internal = path.join(root, '.modmind')
    await fs.mkdir(internal)
    await fs.writeFile(path.join(internal, 'keep.json'), '{}')
    await fs.symlink(internal, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.link(path.join(internal, 'keep.json'), path.join(root, 'alias.json'))
    expect(() => assertAgentWriteAllowed(root, 'alias/new.json')).toThrow('link')
    expect(() => assertAgentWriteAllowed(root, 'alias.json')).toThrow('link')
    expect(() => assertAgentProjectAllowed(path.join(root, 'alias'))).toThrow()
  })

  it.skipIf(!process.env.MODMIND_CODEX_SANDBOX_TEST_EXE)('blocks real native writes and deletion while allowing project changes', async () => {
    const root = await fixture()
    const project = path.join(root, 'project')
    const internal = path.join(project, '.modmind')
    // Also exercise protected islands when a user chooses a broad project root.
    const install = path.join(project, 'application')
    const data = path.join(project, 'AppData', 'ModMind')
    for (const directory of [internal, install, data]) {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'keep.txt'), 'keep')
    }
    configureAgentProtection([install, data])
    const targets = [internal, install, data].map(directory => path.join(directory, 'keep.txt'))
    const script = `const fs = require('fs'); const p = ${JSON.stringify(project)}; fs.writeFileSync(p + '/source.txt', 'ok'); for (const file of ${JSON.stringify(targets)}) { for (const [name, op] of [['write', () => fs.writeFileSync(file, 'broken')], ['delete', () => fs.unlinkSync(file)]]) { try { op(); console.error('UNPROTECTED', name, file); process.exitCode = 4; } catch (error) { console.log('BLOCKED', name, file, error.code); } } }`
    const result = spawnSync(process.env.MODMIND_CODEX_SANDBOX_TEST_EXE!, [
      ...agentProtectionConfigArgs(project), 'sandbox', '-P', 'modmind-protected', '-C', project, '--', process.execPath, '-e', script
    ], { cwd: project, encoding: 'utf8', timeout: 45_000, windowsHide: true })
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0)
    expect(await fs.readFile(path.join(project, 'source.txt'), 'utf8')).toBe('ok')
    for (const target of targets) expect(await fs.readFile(target, 'utf8')).toBe('keep')
  }, 60_000)

  it.skipIf(!process.env.MODMIND_CODEX_SANDBOX_TEST_EXE).each(['auto-review', 'manual'] as const)('accepts the protected %s profile on a real app-server without a model request', async mode => {
    const root = await fixture()
    const project = path.join(root, 'project')
    await fs.mkdir(project)
    const child = spawn(process.env.MODMIND_CODEX_SANDBOX_TEST_EXE!, [
      ...agentProtectionConfigArgs(project),
      '-c', 'approval_policy={granular={sandbox_approval=false,rules=true,skill_approval=true,request_permissions=false,mcp_elicitations=true}}',
      'app-server', '--listen', 'stdio://'
    ], { cwd: project, env: { ...process.env, CODEX_HOME: root }, stdio: 'pipe', windowsHide: true })
    let buffer = ''
    let stderr = ''
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`app-server initialization timeout: ${stderr}`)), 20_000)
        const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve() }
        child.once('error', done)
        child.once('exit', code => done(new Error(`app-server exited ${code}: ${stderr}`)))
        child.stdout.on('data', chunk => {
          buffer += String(chunk)
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
            let message: { id?: number; error?: unknown; result?: { thread?: { id?: string }; permissions?: string } }
            try { message = JSON.parse(line) } catch { continue }
            if (message.error) { done(new Error(JSON.stringify(message.error))); return }
            if (message.id === 1) {
              child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
              child.stdin.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: {
                cwd: project, runtimeWorkspaceRoots: [project], ...codexApprovalPolicy(false, mode), ephemeral: true
              } })}\n`)
            } else if (message.id === 2) {
              if (!message.result?.thread?.id) done(new Error(`Missing thread: ${line}`))
              else done()
            }
          }
        })
        child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'modmind-test', version: 'test' }, capabilities: { experimentalApi: true } } })}\n`)
      })
    } finally {
      child.kill()
      await exited
    }
  }, 30_000)
})
