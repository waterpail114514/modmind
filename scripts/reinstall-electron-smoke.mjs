import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createPackage } from '@electron/asar'

const require = createRequire(import.meta.url)
const workspace = path.resolve(import.meta.dirname, '..')
const cp = require('node:child_process')

if (!process.versions.electron) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-reinstall-electron-'))
  try {
    const source = path.join(root, 'archive-source')
    const install = path.join(root, 'Programs', 'ModMind with spaces')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture"}')
    await fs.mkdir(path.join(install, 'resources'), { recursive: true })
    await createPackage(source, path.join(install, 'resources', 'app.asar'))
    for (const file of ['ModMind.exe', 'Uninstall ModMind.exe']) await fs.writeFile(path.join(install, file), 'fixture')
    await build({ entryPoints: [path.join(workspace, 'src/main/appReinstall.ts')], outfile: path.join(root, 'reinstall.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
    const child = cp.spawnSync(require('electron'), [import.meta.filename, root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(workspace, 'node_modules') },
      encoding: 'utf8', windowsHide: true, timeout: 30000
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    process.stdout.write(child.stdout)
  } finally {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
    await fs.rm(root, { recursive: true, force: true })
  }
} else {
  const root = process.argv[2]
  const install = path.join(root, 'Programs', 'ModMind with spaces')
  const archive = path.join(install, 'resources', 'app.asar')
  assert.equal((await fs.lstat(archive)).isDirectory(), true)
  assert.equal((await require('original-fs').promises.lstat(archive)).isFile(), true)
  const launches = []
  // Exercise production launch code without starting installers or PowerShell.
  cp.spawn = (file, args, options) => {
    launches.push({ file, args, options })
    const child = new EventEmitter()
    child.unref = () => undefined
    queueMicrotask(() => child.emit(file.endsWith('powershell.exe') ? 'error' : 'spawn', new Error('helper blocked')))
    return child
  }
  const { prepareCleanReinstall, prepareOverwriteReinstall } = require(path.join(root, 'reinstall.cjs'))
  const bytes = Buffer.alloc(10 * 1024 * 1024, 7)
  const hash = createHash('sha512').update(bytes).digest('base64')
  const options = {
    executablePath: path.join(install, 'ModMind.exe'), userDataPath: path.join(root, 'Roaming', 'modmind'),
    appDataPath: path.join(root, 'Roaming'), localAppDataPath: path.join(root, 'Local'), homePath: root, tempPath: root,
    protectedPaths: [], updateUrl: 'https://updates.example.com/', helperScriptPath: path.join(workspace, 'resources/reinstall-app.ps1'),
    report: () => undefined,
    fetchManifest: async () => JSON.stringify({ version: '1.4.16', files: [{ url: 'ModMind-Setup-1.4.16.exe', size: bytes.length, sha512: hash }] }),
    download: async request => { await fs.writeFile(request.destination, bytes); return { destination: request.destination } }
  }
  await fs.mkdir(options.userDataPath, { recursive: true })
  await fs.writeFile(path.join(options.userDataPath, 'settings.json'), 'preserve')
  let plan
  const clean = await prepareCleanReinstall({ ...options, launchHelper: async value => { plan = value } })
  await clean()
  assert.ok(plan.cleanupDirectories.includes(install))
  const blocked = await prepareCleanReinstall(options)
  await assert.rejects(blocked(), /helper blocked/)
  const blockedStage = launches[0].options.cwd
  assert.equal(await fs.readFile(path.join(blockedStage, 'cancel'), 'utf8'), 'cancelled')
  await fs.rm(path.join(install, 'Uninstall ModMind.exe'))
  const overwrite = await prepareOverwriteReinstall(options)
  await overwrite()
  assert.equal(launches.length, 2)
  assert.deepEqual(launches[1].args, ['--updated', '--force-run', '/D=' + install])
  assert.equal(launches[1].options.windowsVerbatimArguments, true)
  assert.equal(await fs.readFile(path.join(options.userDataPath, 'settings.json'), 'utf8'), 'preserve')
  assert.equal(await fs.readFile(options.executablePath, 'utf8'), 'fixture')
  process.stdout.write('PASS Electron ASAR validation, helper cancellation, overwrite launch arguments and data preservation\n')
}
