import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import vm from 'node:vm'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

// Isolated Electron window, real plugin protocol/CSP/sandbox, deterministic host replies.
// No installed plugin, account, backend tool, or user project is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, 'test-results/plugin-ui', String(Date.now()))
await mkdir(work, { recursive: true })
const compiled = await build({ stdin: { contents: "export * from './src/shared/appTheme'; export * from './src/shared/scrollbars'; export * from './src/shared/pluginUi'", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false })
const context = { module: { exports: {} } }
vm.runInNewContext(compiled.outputFiles[0].text, context)
const { themeCssVariables, themePresets, scrollbarStyles, createPluginPanelHtml } = context.module.exports
const escapedTitle = '作品 <script>window.INJECTED=true</script> & "名称"'
const scaffoldDir = path.join(work, 'scaffold')
await mkdir(scaffoldDir)
await writeFile(path.join(scaffoldDir, 'index.html'), createPluginPanelHtml(escapedTitle))
const fixtures = [
  { id: 'panel-only', entry: 'panel/index.html', directory: path.join(root, 'resources/plugin-templates/panel-only') },
  { id: 'panel-and-tools', entry: 'panel/index.html', directory: path.join(root, 'resources/plugin-templates/panel-and-tools'), tool: true },
  { id: 'overlay-pet', entry: 'overlay/index.html', directory: path.join(root, 'resources/plugin-templates/overlay-pet'), overlay: true },
  { id: 'scaffold', entry: 'index.html', directory: scaffoldDir }
]
const records = Object.fromEntries(fixtures.map(f => [f.id, { enabled: true, directory: f.directory, manifest: { id: f.id, [f.overlay ? 'overlay' : 'panel']: { entry: f.entry } } }]))
await writeFile(path.join(work, 'host.html'), `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style></head><body>
<iframe id="plugin" title="插件界面测试" sandbox="allow-scripts allow-downloads"></iframe>
<script>
window.fixture = { info: {}, mode: 'success', requests: 0, pending: [] }
window.addEventListener('message', event => {
  const target = document.getElementById('plugin').contentWindow
  if (event.source !== target) return
  const data = event.data
  if (data.type === 'ready') { target.postMessage({ type: 'hostInfo', hostInfo: window.fixture.info }, '*'); return }
  if (!data.requestId) return
  window.fixture.requests++
  const response = window.fixture.mode === 'error'
    ? { type: 'result', requestId: data.requestId, ok: false, error: '测试连接中断' }
    : { type: 'result', requestId: data.requestId, ok: true, result: data.type === 'getProjectInfo' ? window.fixture.info.project : { summary: '项目检查完成', files: 3 } }
  if (window.fixture.mode === 'hold') window.fixture.pending.push(response)
  else target.postMessage(response, '*')
})
</script></body></html>`)
const bootstrap = path.join(work, 'main.cjs')
await build({ stdin: { contents: `
import { app, BrowserWindow } from 'electron'
import { registerPluginProtocol, registerPluginProtocolScheme } from './src/main/pluginProtocol'
app.setPath('userData', ${JSON.stringify(path.join(work, 'profile'))})
registerPluginProtocolScheme()
app.whenReady().then(() => {
  const records = ${JSON.stringify(records)}
  registerPluginProtocol({ getPlugin: id => records[id] })
  const win = new BrowserWindow({ show: false, width: 1040, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  win.loadFile(${JSON.stringify(path.join(work, 'host.html'))})
})`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bootstrap })

let app
const checks = [], errors = []
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap], cwd: root, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.fixture))
  const project = { name: '远山创作计划', kind: 'modpack', path: 'E:/项目/' + '很长的目录名称/'.repeat(12) }
  const themeInfo = (preset, mode, custom) => ({ theme: mode, themePreset: preset, palette: themeCssVariables(preset, mode, custom), scrollbarStyle: scrollbarStyles() })
  for (const fixture of fixtures) {
    const info = { ...themeInfo('modmind', 'light'), project: null, surface: fixture.overlay ? 'overlay' : 'panel' }
    await page.evaluate(({ fixture, info }) => {
      window.fixture = { info, mode: 'success', requests: 0, pending: [] }
      document.getElementById('plugin').src = 'modmind-plugin://' + fixture.id + '/' + fixture.entry
    }, { fixture, info })
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
    await frame.waitForFunction(() => Boolean(window.ModMindUI?.hostInfo))
    if (fixture.id === 'scaffold') {
      assert.equal(await frame.locator('h1').textContent(), escapedTitle)
      assert.equal(await frame.evaluate(() => window.INJECTED), undefined)
    }
    if (!fixture.overlay) {
      assert.equal(await frame.locator('#empty').isVisible(), true)
      if (!fixture.tool) assert.match(await frame.locator('#status').textContent(), /没有打开/)
      await page.evaluate(project => { window.fixture.info.project = project }, project)
      await page.evaluate(() => { window.fixture.mode = 'hold' })
      await frame.locator('#run').focus()
      await page.keyboard.press('Enter')
      await frame.waitForFunction(() => document.getElementById('run').disabled)
      assert.equal(await frame.locator('#run').isDisabled(), true)
      assert.equal(await frame.locator('#result').getAttribute('aria-busy'), 'true')
      await frame.locator('#run').evaluate(button => button.click())
      assert.equal(await page.evaluate(() => window.fixture.requests), 1)
      await page.evaluate(() => {
        const target = document.getElementById('plugin').contentWindow
        window.fixture.pending.splice(0).forEach(value => target.postMessage(value, '*'))
      })
      await frame.waitForFunction(() => !document.getElementById('run').disabled)
      assert.equal(await frame.locator('#empty').isVisible(), false)
      if (fixture.tool) {
        assert.equal(await frame.locator('#summary').textContent(), '项目检查完成')
        await frame.locator('summary').focus()
        await page.keyboard.press('Enter')
        assert.equal(await frame.locator('#details').getAttribute('open'), '')
      } else assert.equal(await frame.locator('#project-name').textContent(), project.name)
      await page.evaluate(() => { window.fixture.mode = 'error' })
      await frame.locator('#run').focus()
      await page.keyboard.press('Enter')
      await frame.waitForFunction(() => document.getElementById('status').dataset.state === 'error')
      assert.equal(await frame.locator('#status').getAttribute('role'), 'alert')
      assert.match(await frame.locator('#status').textContent(), /重试/)
      await page.evaluate(() => { window.fixture.mode = 'success' })
      await frame.locator('#run').focus()
      await page.keyboard.press('Enter')
      await frame.waitForFunction(() => document.getElementById('status').dataset.state === 'success')
      // Exercise the reusable form classes and retain a real draft during live theme changes.
      await frame.evaluate(() => {
        const form = document.createElement('div')
        form.className = 'mm-form mm-section'
        form.innerHTML = '<label class="mm-field">作品名称<input id="draft" value="未保存的名称" /></label><label class="mm-field">制作说明<textarea>保留我的草稿</textarea></label>'
        document.querySelector('.mm-content').appendChild(form)
      })
    }
    const cases = themePresets.flatMap(({ id }) => ['light', 'dark'].map(mode => themeInfo(id, mode)))
    cases.push(themeInfo('modmind', 'dark', { dark: { canvas: '#29272c', accent: '#debd70' } }))
    for (const value of cases) {
      await page.evaluate(value => document.getElementById('plugin').contentWindow.postMessage({ type: 'themeChanged', ...value }, '*'), value)
      await frame.waitForFunction(expected => document.documentElement.style.getPropertyValue('--theme-canvas') === expected, value.palette['--theme-canvas'])
      assert.equal(await frame.evaluate(() => getComputedStyle(document.body).color), await frame.evaluate(color => { const e = document.createElement('span'); e.style.color = color; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c }, value.palette['--theme-text']))
      assert.equal(await frame.evaluate(() => getComputedStyle(document.body, '::-webkit-scrollbar').width), '10px')
      if (!fixture.overlay) assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), await frame.evaluate(color => { const e = document.createElement('span'); e.style.color = color; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c }, value.palette['--theme-canvas']))
      if (!fixture.overlay) assert.equal(await frame.locator('#draft').inputValue(), '未保存的名称')
    }
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot({ path: path.join(work, fixture.id + '-custom-dark.png'), timeout: 5000 })
    // Non-parent messages must not be able to recolor a sandboxed plugin.
    const original = await frame.evaluate(() => document.documentElement.style.getPropertyValue('--theme-canvas'))
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'themeChanged', palette: { '--theme-canvas': 'red' } }, source: null })))
    assert.equal(await frame.evaluate(() => document.documentElement.style.getPropertyValue('--theme-canvas')), original)
    if (fixture.overlay) assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)')
    // Legacy hosts without palette get the centralized fallback, not stale custom values.
    await page.evaluate(() => document.getElementById('plugin').contentWindow.postMessage({ type: 'themeChanged', theme: 'light' }, '*'))
    await frame.waitForFunction(() => document.documentElement.style.getPropertyValue('--theme-canvas') === '')
    assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim()), themeCssVariables('modmind', 'light')['--theme-canvas'])
    for (const width of fixture.overlay ? [160, 320] : [320, 1040]) {
      const height = fixture.overlay ? (width === 160 ? 180 : 260) : 760
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
      await frame.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
      assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), fixture.id + ': horizontal overflow at ' + width)
      if (!fixture.overlay) {
        await frame.locator('#run').focus()
        await page.keyboard.press('Tab')
        const focus = await frame.evaluate(() => ({ tag: document.activeElement.tagName, width: getComputedStyle(document.activeElement).outlineWidth }))
        assert.ok(['SUMMARY', 'INPUT'].includes(focus.tag))
        assert.equal(focus.width, '2px')
      }
      if (fixture.overlay) assert.ok(await frame.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'Pet fits its minimum height')
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: path.join(work, fixture.id + '-' + width + '.png'), timeout: 5000 })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    if (!fixture.overlay) {
      const handle = frame.locator('#run')
      await handle.dispatchEvent('mousedown')
      assert.equal(await handle.evaluate(button => getComputedStyle(button).transitionDuration), '0s')
    }
    checks.push({ plugin: fixture.id, themeCases: cases.length, states: fixture.overlay ? 'transparent overlay' : 'empty, busy, duplicate prevention, result, error, retry, keyboard, draft preservation', widths: fixture.overlay ? [160, 320] : [320, 1040] })
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(work, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
  console.log('PASS: plugin UI smoke checks. Screenshots/report: ' + work)
} finally {
  if (app) await app.close()
}
