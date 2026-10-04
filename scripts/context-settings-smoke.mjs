import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results', 'context-settings-merge')
await mkdir(output, { recursive: true })
const bundle = await build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import ModelContextSetting from './src/renderer/src/components/ModelContextSetting'
    import './src/renderer/src/styles.css'
    import './src/renderer/src/palette.css'
    import { applyAppearance } from './src/renderer/src/theme'
    window.setTheme = darkMode => applyAppearance({ darkMode, themePreset: 'neutral' })
    function Fixture() {
      const [allowLongerContext, setAllowLongerContext] = useState(false)
      const [value, setValue] = useState()
      const [compactValue, setCompactValue] = useState()
      const [saving, setSaving] = useState(false)
      window.setSaving = setSaving
      return <main className="main-content" data-view="settings"><div className="settings-page"><section id="settings-ai" className="settings-section">
        <div className="settings-heading"><h2>AI 模型</h2></div>
        <ModelContextSetting model="fixture" value={value} compactValue={compactValue} allowLongerContext={allowLongerContext}
          saving={saving} onAllowLongerContextChange={setAllowLongerContextChange} onSave={(v, c) => { setValue(v); setCompactValue(c) }} />
      </section></div></main>
      function setAllowLongerContextChange(next) { setAllowLongerContext(next) }
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  ` }, bundle: true, write: false, outdir: output, format: 'iife', jsx: 'automatic'
})
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div></body></html>')
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text })
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text })
  const toggle = page.getByRole('switch', { name: '允许更长上下文（可能造成更多消费）' })
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await toggle.click()
  await page.getByRole('textbox', { name: '模型上下文窗口（tokens）' }).fill('512000')
  await page.getByRole('textbox', { name: '自动压缩阈值（tokens）' }).fill('470000')
  await page.getByRole('button', { name: '保存模型设置' }).click()
  assert.match(await page.getByRole('alert').innerText(), /90%/)
  await page.getByRole('textbox', { name: '自动压缩阈值（tokens）' }).fill('200000')
  await page.getByRole('button', { name: '保存模型设置' }).click()
  await page.getByRole('button', { name: '恢复自动' }).click()
  assert.equal(await page.getByRole('textbox', { name: '自动压缩阈值（tokens）' }).inputValue(), '')
  await page.evaluate(() => window.setSaving(true))
  await page.waitForFunction(() => document.querySelector('[role="switch"]').disabled)
  await page.evaluate(() => window.setSaving(false))
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 800 })
    for (const dark of [false, true]) {
      await page.evaluate(value => window.setTheme(value), dark)
      await page.screenshot({ path: path.join(output, `${width}-${dark ? 'dark' : 'light'}.png`) })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`)
      const bounds = await toggle.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `toggle outside viewport at ${width}`)
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS context settings: toggle, manual validation, reset, saving state, light/dark at 1440/760/390')
} finally {
  await browser.close()
}
