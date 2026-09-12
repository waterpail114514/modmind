import { test, expect } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('workbench renders streams, narrow panes and accessible interactions without layout errors', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { entries: ['test-results/workbench-scroll-ui.html'] }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors: string[] = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/workbench-scroll-ui.html`)
    await page.waitForFunction(() => (window as any).configureWorkbench)
    const configure = (options: object) => page.evaluate(options => (window as any).configureWorkbench(options), options)
    const row = { id: 'stream', kind: 'response', status: 'running', content: '', time: new Date().toISOString() }
    await configure({ rows: [row], width: 390 })
    const scroller = page.locator('.agent-conversation')
    await expect.poll(() => page.locator('.agent-conversation-row').evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height > 0))).toBe(true)
    await configure({ rows: [{ ...row, time: 'invalid legacy timestamp', content: '首条回复' }], width: 390 })
    await page.getByText('首条回复', { exact: true }).waitFor()
    await page.route('**/fixture-image.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"><rect width="2000" height="100" fill="teal"/></svg>' }))
    await configure({ rows: [{ ...row, content: '[**文档** & `代码`](https://example.com)\n\n```js\n' + 'const longValue = 1; '.repeat(60) + '\n```\n\n| A | B |\n| --- | --- |\n| ' + '文件名'.repeat(100) + ' | 内容 |\n\n![预览](/fixture-image.svg)' }], width: 390 })
    await page.locator('.agent-markdown a strong').waitFor()
    expect(await page.locator('.agent-markdown a code').textContent()).toBe('代码')
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.querySelector('#root > div')!.className = dark ? 'app-shell dark-mode' : '', dark)
      expect(await page.locator('.agent-markdown pre code').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    }
    expect(await page.locator('.agent-markdown img').evaluate(el => el.getBoundingClientRect().width <= el.parentElement!.clientWidth)).toBe(true)
    expect(await scroller.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThan(2)

    for (const width of [320, 390, 480, 760, 1000]) {
      await configure({ width, planning: false, uiMode: 'advanced', persistenceMessage: '很长的保存状态'.repeat(20), attachments: Array.from({ length: 8 }, (_, index) => ({ id: String(index), path: `/tmp/${index}`, name: 'very-long-attachment-name.txt', size: 100 })) })
      await expect.poll(() => page.locator('.agent-workbench').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThan(2)
      expect(await page.locator('.agent-composer').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThan(2)
      const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
      expect(send!.x + send!.width).toBeLessThanOrEqual(width)
    }
    await configure({ width: 390, planning: false, uiMode: 'advanced' })
    const input = page.getByRole('textbox', { name: '发送给 AI 的消息' })
    await input.fill('第一行')
    await input.press('Shift+Enter')
    expect(await input.inputValue()).toBe('第一行\n')
    await input.fill('多行内容\n'.repeat(12))
    await expect.poll(() => input.evaluate(el => el.clientHeight)).toBeGreaterThan(100)
    expect(await input.evaluate(el => el.clientHeight)).toBeLessThanOrEqual(200)
    await input.fill('短消息')
    await expect.poll(() => input.evaluate(el => el.clientHeight)).toBeLessThan(60)

    const engine = page.getByRole('button', { name: '开发引擎：智能引擎' })
    await engine.focus()
    await engine.press('Enter')
    await page.locator('.agent-picker > .agent-picker-menu').waitFor()
    await page.keyboard.press('Escape')
    expect(await engine.evaluate(el => el === document.activeElement)).toBe(true)
    expect(await engine.getAttribute('aria-expanded')).toBe('false')
    await engine.click()
    await input.click()
    await expect.poll(() => engine.getAttribute('aria-expanded')).toBe('false')
    const context = page.locator('.agent-context-ring')
    await context.focus()
    await context.press('Enter')
    await page.locator('#agent-context-window').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    expect(await context.evaluate(el => el === document.activeElement)).toBe(true)
    await page.locator('#agent-context-window').waitFor({ state: 'hidden' })

    await configure({ width: 480, rows: [{ ...row, id: 'tool', kind: 'tool', status: 'done', content: '检查文件\n' + '详细信息 '.repeat(100) }], planning: true })
    const disclosure = page.getByRole('button', { name: '查看步骤 · 1' })
    await disclosure.click()
    expect(await disclosure.getAttribute('aria-expanded')).toBe('true')
    await page.getByRole('button', { name: '回到最新内容' }).waitFor()
    await page.waitForTimeout(150)
    const position = await scroller.evaluate(el => el.scrollTop)
    await page.evaluate(() => (window as any).appendOutput())
    await page.waitForTimeout(150)
    expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - position)).toBeLessThan(5)
    await page.getByRole('button', { name: '回到最新内容' }).click()
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(5)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.agent-processing-bar .spin').evaluate(el => getComputedStyle(el).animationIterationCount)).toBe('1')
    // Large histories must remain virtualized while streaming and switching views.
    await configure({ width: 1000, rows: Array.from({ length: 1000 }, (_, index) => ({ ...row, id: `history-${index}`, content: `历史消息 ${index}\n\n${'项目检查结果。'.repeat(20)}` })) })
    await page.getByText('历史消息 999', { exact: true }).waitFor()
    expect(await page.locator('[data-item-index]').count()).toBeLessThan(40)
    await page.evaluate(async () => {
      for (let index = 0; index < 30; index++) {
        (window as any).growOutput()
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
    })
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(5)
    expect(await page.locator('[data-item-index]').count()).toBeLessThan(40)
    for (const width of [320, 390, 760]) {
      await configure({ width, rows: [], planning: false, presentation: 'minimal', beginnerAiPreferences: { model: 'test-model', reasoningLevel: 'high', fastMode: false } })
      await page.getByRole('region', { name: '开始创作' }).waitFor()
      await expect.poll(() => page.locator('.agent-workbench').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThan(2)
      expect(await page.locator('.agent-composer').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThan(2)
    }
    expect(errors).toEqual([])
    await page.screenshot({ path: 'artifacts/workbench-render-verified.png' })
  } finally { await browser.close(); await server.close() }
}, 60_000)
