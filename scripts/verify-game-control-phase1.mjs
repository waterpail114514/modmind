import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { command, click, input, key } from './game-control-driver.mjs'

// End-to-end verification with the actual owned Minecraft process and business
// transport. No game state APIs, foreground input, clipboard or OS typing.
const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = path.resolve(value('directory'))
const version = value('version') || '1.20.1'
const legacy = version === '1.12.2'
const sourceWorld = value('world')
const args = ['scripts/game-control-smoke.mjs', `--directory=${directory}`, `--version=${version}`, `--java=${value('java')}`]
if (value('resources')) args.push(`--resources=${path.resolve(value('resources'))}`)
await fs.mkdir(directory, { recursive: true })
if (sourceWorld) await fs.cp(path.resolve(sourceWorld), path.join(directory, 'game/saves', path.basename(sourceWorld)), { recursive: true })
const harness = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let diagnostics = '', exited = false
harness.stdout.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-12000) })
harness.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-12000) })
harness.once('exit', () => { exited = true })
async function until(read, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Game harness exited: ${diagnostics}`)
    const result = await read().catch(() => null)
    if (result && check(result)) return result
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Verification timed out: ${diagnostics}`)
}
const readJson = name => fs.readFile(path.join(directory, name), 'utf8').then(JSON.parse)
try {
  const launch = await until(() => readJson('launch.json'), value => value.pid > 0)
  const ready = await until(() => readJson('state.json'), value => value.ready)
  const placement = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', 'scripts/prepare-game-control-test-window.ps1', '-GameProcessId', String(launch.pid)], { encoding: 'utf8', windowsHide: true }))
  await fs.writeFile(path.join(directory, 'placement.json'), JSON.stringify(placement, null, 2))
  if (!placement.foregroundUnchanged) throw new Error('Placing the owned test window changed foreground focus')
  await until(() => fs.stat(path.join(directory, 'first.png')), value => value.size > 0)
  // Agent readiness can precede Minecraft's title screen (resource reload).
  await until(() => fs.readFile(path.join(directory, 'game.log'), 'utf8'), value => legacy ? value.includes('Narrator library') : value.includes('textures/atlas/mob_effects'))
  await new Promise(resolve => setTimeout(resolve, 2500))
  // Select the pre-existing test world through the visible menu.
  await click(directory, 480, 250); await click(directory, 390, 130); await click(directory, 320, 455)
  await until(() => fs.readFile(path.join(directory, 'game.log'), 'utf8'), value => value.includes('joined the game'))
  await new Promise(resolve => setTimeout(resolve, 1000))
  const observer = spawn('powershell.exe', ['-NoProfile', '-File', 'scripts/observe-game-control-desktop.ps1', '-GameProcessId', String(launch.pid), '-DurationMs', '6000', '-Output', path.join(directory, 'desktop.json')], { windowsHide: true, stdio: 'ignore' })
  const observed = new Promise((resolve, reject) => { observer.once('exit', code => code === 0 ? resolve() : reject(new Error('Desktop observation failed'))); observer.once('error', reject) })
  await key(directory, legacy ? 61 : 292, 100) // The game's own F3 screen shows coordinates and orientation.
  const before = await command(directory, { operation: 'capture' })
  await input(directory, { type: 'key', code: legacy ? 31 : 83, state: 'down', leaseMs: 1000 })
  await input(directory, { type: 'look', x: 120, y: -20 })
  await input(directory, { type: 'look', x: 120, y: -20 })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const after = await command(directory, { operation: 'capture' })
  await key(directory, legacy ? 18 : 69, 100)
  const inventory = await command(directory, { operation: 'capture' })
  await observed
  const desktop = await readJson('desktop.json')
  if (desktop.gameEverForeground) throw new Error('Game became foreground during virtual input')
  const state = await command(directory, { operation: 'status' })
  if (state.keysDown.length || state.buttonsDown.length || !state.physicalCallbacksFiltered || state.error) throw new Error('Virtual input isolation/cleanup did not pass')
  if (after.frameId <= before.frameId || after.capturedAt <= before.capturedAt) throw new Error('Capture did not return a fresh frame')
  await key(directory, legacy ? 18 : 69, 100); await key(directory, legacy ? 61 : 292, 100)
  await key(directory, legacy ? 20 : 84, 100)
  await input(directory, { type: 'text', text: 'ModMind background 中文输入' })
  const text = await command(directory, { operation: 'capture' })
  const images = {}
  for (const [name, frame] of Object.entries({ before, after, inventory, text })) {
    const bytes = await fs.readFile(path.join(directory, frame.image))
    images[name] = { ...frame, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  }
  const report = { version, launch, ready, placement, images, finalState: state, gameEverForeground: desktop.gameEverForeground, desktopSamples: desktop.samples.length,
    cursorClips: [...new Set(desktop.samples.map(sample => sample.clip.join(',')))],
    assertions: { freshFrame: true, heldKeysReleased: true, physicalCallbacksFiltered: true, foregroundUnchanged: true },
    visualInspectionRequired: ['before/after coordinate and camera change', 'inventory visible', 'ASCII/Chinese characters visible'],
    scope: 'Windows two-family baseline; no Loader-wide compatibility claim, no MCP integration, no foreground typing witness' }
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  // Exit chat and save the isolated world using the game's own UI.
  await key(directory, legacy ? 1 : 256, 100); await key(directory, legacy ? 1 : 256, 100)
  await click(directory, 480, legacy ? 376 : 362)
  await until(() => fs.readFile(path.join(directory, 'game.log'), 'utf8'), value => value.includes('Saving chunks') || value.includes('Saving worlds'), 15000)
  await command(directory, { operation: 'stop' })
} finally {
  if (!exited) {
    await command(directory, { operation: 'stop' }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 300))
    if (!exited) harness.kill()
  }
}
