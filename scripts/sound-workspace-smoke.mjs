import { _electron as electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import ffmpeg from 'ffmpeg-static'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'sound-workspace', String(Date.now()))
const profile = path.join(work, 'profile'), projectPath = path.join(work, 'project')
const assets = path.join(projectPath, 'src/main/resources/assets/sound_smoke')
await mkdir(path.join(assets, 'sounds/ui'), { recursive: true })
await mkdir(profile, { recursive: true })
await writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify({ name: '声音验收', namespace: 'sound_smoke', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1', path: projectPath, createdAt: '', projectVersion: '1.4.11' }))
await writeFile(path.join(projectPath, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'sound_smoke', version: '0.1.0', name: '声音验收' }))
await writeFile(path.join(assets, 'sounds.json'), JSON.stringify({ 'ui/chime': { sounds: [{ name: 'sound_smoke:ui/chime', weight: 2 }] } }))
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5', '-c:a', 'libvorbis', path.join(assets, 'sounds/ui/chime.ogg')], { stdio: 'ignore' })
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, "const { app } = require('electron'); app.setName('modmind-sound-smoke'); app.setPath('userData', " + JSON.stringify(profile) + "); app.setAppPath(" + JSON.stringify(root) + "); require(" + JSON.stringify(path.join(root, 'out/main/index.js')) + ");")
const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), publicDir: path.join(root, 'resources/renderer-public'), plugins: [react()], resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 0 } })
let app, page
try {
  await server.listen()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [bootstrap, '--user-data-dir=' + profile], cwd: root, env })
  await app.firstWindow({ timeout: 120000 })
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(env.ELECTRON_RENDERER_URL))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => { window.webContents.setBackgroundThrottling(false); window.hide() }))
  for (let attempt = 0; attempt < 50 && !await page.evaluate(() => Boolean(window.modmind)); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await page.evaluate(() => Boolean(window.modmind)))
  await page.evaluate(target => window.modmind.project.openRecent(target), projectPath)
  await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'advanced'))
  await page.reload()
  const sidebar = page.locator('#main-sidebar')
  await sidebar.getByRole('button', { name: '切换项目：声音验收', exact: true }).waitFor()
  const button = sidebar.getByRole('button', { name: '声音', exact: true, includeHidden: true }).and(sidebar.locator('button:not(.nav-caption)'))
  const caption = button.locator('..').locator('..').locator('.nav-caption')
  if (await caption.getAttribute('aria-expanded') === 'false') await caption.click()
  await button.click()
  const snapshot = async name => {
    await page.screenshot({ path: path.join(work, name + '.png') })
    const overflow = await page.locator('.main-content').evaluate(element => element.scrollWidth - element.clientWidth)
    assert.ok(overflow <= 2, name + ': main content overflow ' + overflow)
    const pageOverflow = await page.locator('.production-page').evaluate(element => ({ x: element.scrollWidth - element.clientWidth, y: element.scrollHeight - element.clientHeight }))
    assert.ok(pageOverflow.x <= 2 && pageOverflow.y <= 2, name + ': production page overflow ' + JSON.stringify(pageOverflow))
  }
  const waitAudio = async locator => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await locator.evaluate(element => Number.isFinite(element.duration) && element.duration > 0).catch(() => false)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Audio did not load: ' + JSON.stringify(await locator.evaluate(element => ({ readyState: element.readyState, networkState: element.networkState, error: element.error?.message, sourceLength: element.src.length, canPlay: element.canPlayType('audio/ogg; codecs="vorbis"') })).catch(error => String(error))))
  }
  await page.getByRole('tab', { name: '声音库' }).waitFor()
  await page.getByRole('button', { name: /ui\/chime/ }).first().click()
  await page.getByRole('button', { name: /chime/ }).last().click()
  await page.locator('.sound-player-row audio').waitFor()
  await waitAudio(page.locator('.sound-player-row audio'))
  await snapshot('library-desktop')
  await page.getByRole('tab', { name: '事件' }).click()
  await page.getByRole('button', { name: /ui\/chime/ }).first().click()
  await page.getByLabel('权重').fill('5')
  await page.getByRole('button', { name: '保存事件' }).click()
  await page.getByText('事件已保存').waitFor()
  assert.equal(JSON.parse(await readFile(path.join(assets, 'sounds.json'), 'utf8'))['ui/chime'].sounds[0].weight, 5)
  await snapshot('events-desktop')
  await page.getByRole('tab', { name: '制作' }).click()
  await page.getByRole('button', { name: '生成试听' }).click()
  await page.locator('.sound-studio-preview audio').waitFor()
  await waitAudio(page.locator('.sound-studio-preview audio'))
  await page.getByRole('button', { name: '导出到项目' }).click()
  await page.getByText(/已导出到项目声音事件/).waitFor()
  const generated = JSON.parse(await readFile(path.join(assets, 'sounds.json'), 'utf8'))
  assert.ok(generated['ui/pickup'])
  await page.getByRole('button', { name: '添加素材' }).click()
  await page.locator('.sound-layer-results button').filter({ hasText: 'chime' }).first().click()
  await page.getByRole('button', { name: '生成试听' }).click()
  await page.locator('.sound-studio-preview audio').waitFor()
  await waitAudio(page.locator('.sound-studio-preview audio'))
  await snapshot('studio-effect-desktop')
  await page.getByRole('button', { name: '音乐', exact: true }).click()
  const beepbox = page.frameLocator('iframe[title="BeepBox 音乐编辑器"]')
  await beepbox.locator('.beepboxEditor').waitFor()
  const frameBox = await page.locator('iframe[title="BeepBox 音乐编辑器"]').boundingBox()
  const editorLayout = await beepbox.locator('.beepboxEditor').evaluate(element => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }
    return { editor: rect(element), pattern: rect(element.querySelector('.pattern-area')), tracks: rect(element.querySelector('.track-area')), settings: rect(element.querySelector('.settings-area')) }
  })
  assert.ok(editorLayout.editor.height <= (frameBox?.height ?? 0) + 2, 'BeepBox editor escaped iframe viewport')
  assert.ok(editorLayout.settings.y + editorLayout.settings.height <= editorLayout.editor.height + 2, 'BeepBox settings escaped editor viewport')
  const pianoGeometry = await beepbox.locator('.piano-button[style*="--black-piano-key"]').first().evaluate(element => {
    const key = element.getBoundingClientRect(), cap = getComputedStyle(element, '::before')
    return { keyHeight: key.height, capHeight: parseFloat(cap.height), keyWidth: key.width, capWidth: parseFloat(cap.width) }
  })
  assert.ok(pianoGeometry.capHeight >= pianoGeometry.keyHeight - 1 && pianoGeometry.capWidth >= pianoGeometry.keyWidth * .7, 'Black piano keys render as short marks')
  assert.ok(await beepbox.locator('#octaveScrollBarContainer').isVisible(), 'Octave scrollbar is hidden')
  const octaveBefore = await beepbox.locator('.beepboxEditor').evaluate(() => editor.doc.song.channels[editor.doc.channel].octave)
  await beepbox.locator('.piano-button').first().hover()
  await page.mouse.wheel(0, -120)
  const octaveAfter = await beepbox.locator('.beepboxEditor').evaluate(() => editor.doc.song.channels[editor.doc.channel].octave)
  assert.ok(octaveAfter > octaveBefore, 'Piano wheel did not change the visible octave')
  await page.mouse.wheel(0, 120)
  assert.equal(await beepbox.locator('.beepboxEditor').evaluate(() => editor.doc.song.channels[editor.doc.channel].octave), octaveBefore, 'Piano wheel did not restore the visible octave')
  const settingsGeometry = await beepbox.locator('.settings-area').evaluate(element => {
    const song = element.querySelector('.song-settings-area').getBoundingClientRect()
    const instrument = element.querySelector('.instrument-settings-area > .editor-controls').getBoundingClientRect()
    return { songBottom: song.bottom, instrumentTop: instrument.top, overflowX: element.scrollWidth - element.clientWidth }
  })
  assert.ok(settingsGeometry.instrumentTop >= settingsGeometry.songBottom - 2, 'Instrument controls overlap song settings')
  assert.ok(settingsGeometry.overflowX <= 2, 'Settings have horizontal overflow')
  await page.waitForFunction(target => {
    const stored = localStorage.getItem('modmind.sound.studio.' + target)
    return stored && JSON.parse(stored).music.beepboxSong?.length > 0
  }, projectPath)
  await beepbox.locator('.pattern-area svg:has(#patternEditorNoteBackground0)').click({ position: { x: 120, y: 180 } })
  await page.getByRole('button', { name: '生成试听' }).waitFor({ state: 'visible' })
  for (let attempt = 0; attempt < 50 && await page.getByRole('button', { name: '生成试听' }).isDisabled(); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await page.getByRole('button', { name: '生成试听' }).isDisabled(), false)
  await page.getByRole('button', { name: '保存工程' }).click()
  const savedDraft = JSON.parse(await page.evaluate(target => window.modmind.production.sounds.readDraft(target), projectPath))
  assert.ok(savedDraft.music.beepboxSong.length > 0)
  await page.getByRole('button', { name: '生成试听' }).click()
  await page.locator('.sound-studio-preview audio').waitFor()
  await waitAudio(page.locator('.sound-studio-preview audio'))
  await page.getByRole('button', { name: '导出到项目' }).click()
  await page.getByText(/已导出到项目声音事件/).waitFor()
  assert.ok((await readFile(path.join(assets, 'sounds/ui/pickup_2.ogg'))).subarray(0, 4).toString() === 'OggS')
  await snapshot('studio-music-desktop')
  await beepbox.locator('.beepboxEditor').evaluate(() => {
    editor.doc.song.barCount = 16
    for (const channel of editor.doc.song.channels) while (channel.bars.length < 16) channel.bars.push(0)
    editor.doc.notifier.changed()
  })
  await beepbox.locator('.modmind-bar-scroll').waitFor({ state: 'visible' })
  const trackWidth = await beepbox.locator('.track-area').evaluate(element => ({ width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, editorRight: element.parentElement.getBoundingClientRect().right }))
  assert.ok(trackWidth.right <= trackWidth.editorRight + 2, 'Track area is clipped by editor')
  await beepbox.locator('.modmind-bar-scroll').click({ position: { x: 250, y: 11 } })
  assert.ok(await beepbox.locator('.beepboxEditor').evaluate(() => editor.doc.barScrollPos > 0), 'Bar navigation cannot reach later bars')
  const longTrack = await beepbox.locator('.track-area').evaluate(element => {
    const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } }
    const loop = element.querySelector('.loopEditor')
    return { rows: [...element.querySelectorAll('.channelRow')].slice(0, 4).map(box), loop: box(loop), range: box(element.querySelector('.modmind-bar-scroll')) }
  })
  assert.ok(longTrack.rows.length === 4 && longTrack.loop.top >= longTrack.rows[3].bottom - 1, 'Loop range overlaps the last track')
  await snapshot('studio-music-long-song')
  await beepbox.locator('.modmind-bar-scroll').click({ position: { x: 8, y: 11 } })
  assert.equal(await beepbox.locator('.beepboxEditor').evaluate(() => editor.doc.barScrollPos), 0, 'Bar navigation cannot return to the first bars')
  await page.setViewportSize({ width: 640, height: 900 })
  for (const [view, region] of [['编排', '.track-area'], ['音色', '.settings-area'], ['音符', '.pattern-area']]) {
    await page.getByRole('button', { name: view, exact: true }).click()
    await beepbox.locator(region).waitFor({ state: 'visible' })
    if (view === '音色') {
      const settings = beepbox.locator('.settings-area')
      await settings.hover()
      await page.mouse.wheel(0, 600)
      let scrolled = false
      for (let attempt = 0; attempt < 20; attempt++) {
        scrolled = await settings.evaluate(element => element.scrollTop > 0)
        if (scrolled) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(scrolled, 'Instrument settings cannot scroll internally')
    }
    await snapshot('studio-' + view + '-narrow')
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const [tab, screenshot] of [['声音库', 'library-narrow'], ['事件', 'events-narrow'], ['制作', 'studio-narrow']]) {
    await page.getByRole('tab', { name: tab }).click()
    await page.setViewportSize({ width: 640, height: 900 })
    await snapshot(screenshot)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await page.evaluate(async () => { const settings = await window.modmind.settings.getAgent(); await window.modmind.settings.saveAgent({ ...settings, darkMode: true }) })
  for (let attempt = 0; attempt < 50 && await page.locator('html').getAttribute('data-theme-mode') !== 'dark'; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  await page.setViewportSize({ width: 640, height: 900 })
  await snapshot('studio-dark-narrow')
  const hostColors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return { text: style.getPropertyValue('--theme-text').trim(), accent: style.getPropertyValue('--theme-accent').trim() }
  })
  await page.waitForFunction(({ text, accent }) => {
    const frame = document.querySelector('iframe[title="BeepBox 音乐编辑器"]')
    const style = frame?.contentDocument && getComputedStyle(frame.contentDocument.documentElement)
    return style?.getPropertyValue('--primary-text').trim() === text && style?.getPropertyValue('--loop-accent').trim() === accent
  }, hostColors)
  const originalAccent = await page.evaluate(() => {
    const root = document.documentElement
    const original = root.style.getPropertyValue('--theme-accent')
    const next = getComputedStyle(root).getPropertyValue('--theme-detail').trim()
    root.style.setProperty('--theme-accent', next)
    return { original, next }
  })
  await page.waitForFunction(next => {
    const frame = document.querySelector('iframe[title="BeepBox 音乐编辑器"]')
    return frame?.contentDocument && getComputedStyle(frame.contentDocument.documentElement).getPropertyValue('--loop-accent').trim() === next
  }, originalAccent.next)
  await page.evaluate(original => document.documentElement.style.setProperty('--theme-accent', original), originalAccent.original)
  assert.deepEqual(errors, [])
  console.log('PASS: sound workspace smoke; artifacts: ' + work)
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  console.error('Sound smoke artifacts: ' + work)
  throw error
} finally {
  if (app) await app.close()
  await server.close()
}
