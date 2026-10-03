import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-dev-profile-'))
const children = []
try {
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/main/developmentPaths.ts')],
    outfile: path.join(root, 'paths.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  for (const name of ['workspace-a', 'workspace-b']) {
    const directory = path.join(root, name)
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'modmind', version: '1.4.16', main: 'main.cjs' }))
    await fs.writeFile(path.join(directory, 'main.cjs'), `
const { app } = require('electron');
require('../paths.cjs').configureDevelopmentPaths(app, {});
const locked = app.requestSingleInstanceLock();
app.on('second-instance', () => {});
process.stdin.on('data', () => app.exit(0));
setInterval(() => {}, 1000);
app.whenReady().then(() => console.log('PROFILE:' + JSON.stringify({ locked, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), logs: app.getPath('logs') })));
`)
  }
  async function launch(name, args = []) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [path.join(root, name), ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    return new Promise((resolve, reject) => {
      let output = '', errors = ''
      const timer = setTimeout(() => reject(new Error('Electron profile probe timed out: ' + errors)), 30000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Probe exited before readiness: ${code} ${errors}`)) })
      child.stderr.on('data', chunk => { errors += chunk })
      child.stdout.on('data', chunk => {
        output += chunk
        const line = output.split(/\r?\n/).find(line => line.startsWith('PROFILE:') && line.endsWith('}'))
        if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(8))) }
      })
    })
  }
  const a = await launch('workspace-a'), b = await launch('workspace-b')
  assert.equal(a.locked, true)
  assert.equal(b.locked, true)
  assert.notEqual(a.userData, b.userData)
  assert.equal(a.userData, path.join(root, 'workspace-a/.modmind-dev/userData'))
  assert.equal(a.sessionData, a.userData)
  assert.equal(a.logs, path.join(a.userData, 'logs'))
  await fs.writeFile(path.join(a.userData, 'isolation.txt'), 'workspace A')
  await assert.rejects(fs.access(path.join(b.userData, 'isolation.txt')), { code: 'ENOENT' })
  assert.equal((await launch('workspace-a')).locked, false)
  const explicit = await launch('workspace-a', ['--user-data-dir=' + path.join(root, 'explicit-profile')])
  assert.equal(explicit.locked, true)
  assert.equal(explicit.userData, path.join(root, 'explicit-profile'))
  console.log('PASS: two workspaces own separate profiles and instance locks; same-workspace duplicates are blocked; explicit profiles remain isolated')
} finally {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.stdin.write('quit\n')
    const timer = setTimeout(() => child.kill(), 5000)
    timer.unref()
  })))
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  await fs.rm(root, { recursive: true, force: true })
}
