import { test, expect } from 'vitest'
import { chromium, _electron } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('large conversations keep visible messages during rapid scrolling', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { entries: ['test-results/workbench-scroll-ui.html'] }, server: { host: '127.0.0.1', port: 5199 } })
  await server.listen()
  const desktop = process.env.WORKBENCH_STRESS_ELECTRON ? await _electron.launch({ args: ['test-results/workbench-scroll-electron.cjs'], env: { ...process.env, WORKBENCH_STRESS_URL: `${server.resolvedUrls!.local[0]}test-results/workbench-scroll-ui.html` } }) : null
  const browser = desktop ? null : await chromium.launch({ headless: true })
  try {
    const page = desktop ? await desktop.firstWindow() : await browser!.newPage({ viewport: { width: 1920, height: 1080 } })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/workbench-scroll-ui.html`)
    await page.waitForFunction(() => Boolean((window as any).configureWorkbench))
    const scroller = page.locator('.agent-conversation[data-virtuoso-scroller]')
    for (const scenario of ['mixed', 'long-answer', 'uneven', 'huge']) {
      await page.evaluate(scenario => {
        const paragraphs = ['最终证据齐全：我只再取关键文件行号，随后交付结果与替换说明。', '最后发现文档还保留旧的质量档描述，我会同步为当前固定超低与四种外观，避免使用说明与代码不一致。', '说明文档已同步。现在执行最终内容校验、托管构建和隐藏启动冒烟。']
        const rows = Array.from({ length: scenario === 'mixed' || scenario === 'uneven' ? 2000 : 120 }, (_, i) => ({
          id: `${scenario}-${i}`, kind: i % 4 === 0 ? 'user' : 'answer', time: '2026-09-12T11:48:00Z',
          content: `消息 ${i}\n\n` + Array.from({ length: scenario === 'mixed' ? 1 + (i * 17 % 25) : scenario === 'uneven' ? (i % 19 === 0 ? 3000 : 1) : scenario === 'huge' ? (i === 119 ? 18000 : 3) : 300 }, (_, j) => paragraphs[j % 3]).join('\n\n')
        }))
        ;(window as any).configureWorkbench({ rows, activeConversationId: scenario, dark: true, planning: false, uiMode: 'professional' })
      }, scenario)
      await page.waitForTimeout(1200)
      expect(await scroller.evaluate(el => el.scrollHeight)).toBeLessThan(33_554_432)
      await scroller.hover()
      await page.mouse.wheel(0, -800)
      await page.waitForTimeout(200)
      for (let i = 0; i < 32; i++) {
        await scroller.evaluate((el, i) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * ((i * 37 % 101) / 100) }, i)
        await page.mouse.wheel(0, i % 2 ? 2400 : -2400)
        await page.waitForTimeout(80)
        const state = await scroller.evaluate(el => {
          const bounds = el.getBoundingClientRect()
          const items = [...el.querySelectorAll('[data-item-index]')]
          return { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, rendered: items.length, visible: items.filter(item => { const b = item.getBoundingClientRect(); return getComputedStyle(item).visibility === 'visible' && b.bottom > bounds.top && b.top < bounds.bottom }).length, list: el.querySelector('[data-testid="virtuoso-item-list"]')?.getAttribute('style') }
        })
        if (!state.visible) {
          await page.waitForTimeout(600)
          await page.screenshot({ path: `test-results/workbench-stress-${scenario}-blank.png` })
          console.log(scenario, i, state)
        }
        expect(state.visible, JSON.stringify({ scenario, i, ...state })).toBeGreaterThan(0)
      }
      await page.getByRole('button', { name: '回到最新内容' }).click()
      await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
    }
    expect(errors).toEqual([])
  } finally { await desktop?.close(); await browser?.close(); await server.close() }
}, 120_000)
