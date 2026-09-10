import { test, expect } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

test('workbench and inspiration welcome suggestions fill drafts without sending and support dark/narrow layouts', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], optimizeDeps: { entries: ['test-results/chat-welcome-ui.html'] }, server: { host: '127.0.0.1', port: 5196, strictPort: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    for (const width of [1440, 390]) for (const mode of ['workbench', 'inspiration']) for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${server.resolvedUrls!.local[0]}test-results/chat-welcome-ui.html?mode=${mode}${dark ? '&dark' : ''}`)
      const options = page.locator('.chat-welcome-options > button')
      await options.first().waitFor()
      expect(await options.count()).toBe(3)
      const names = await options.allTextContents()
      expect(new Set(names).size).toBe(3)
      const greeting = await page.locator('.chat-welcome h2').textContent()
      const draft = page.locator('textarea')
      const selectedPrompt = await options.first().getAttribute('title')
      await options.first().click()
      expect(await draft.inputValue()).toBe(selectedPrompt)
      expect(await draft.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.evaluate(() => (window as any).sent.length)).toBe(0)
      await draft.fill('我想先聊聊森林里的冒险')
      expect(await page.locator('.chat-welcome h2').textContent()).toBe(greeting)
      expect(await options.allTextContents()).toEqual(names)
      await page.getByRole('button', { name: '换一组推荐' }).click()
      expect(await draft.inputValue()).toBe('我想先聊聊森林里的冒险')
      expect(await page.locator('.chat-welcome h2').textContent()).toBe(greeting)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const textareaBounds = await draft.boundingBox()
      const optionsBounds = await page.locator('.chat-welcome-options').boundingBox()
      expect(optionsBounds!.y + optionsBounds!.height).toBeLessThanOrEqual(textareaBounds!.y)
      await page.screenshot({ path: path.resolve(`test-results/welcome-${mode}-${width}${dark ? '-dark' : ''}.png`), fullPage: true })
      if (mode === 'inspiration') {
        expect(await page.locator('.inspiration-sidebar').count()).toBe(0)
        await page.getByRole('button', { name: '发送', exact: true }).click()
        await page.getByRole('button', { name: '交给工作台' }).waitFor()
        expect(await page.locator('.inspiration-messages').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2)
        expect(await page.getByRole('combobox', { name: '切换灵感对话' }).locator('option:checked').textContent()).toBe('我想先聊聊森林里的冒险')
        await page.screenshot({ path: path.resolve(`test-results/inspiration-conversation-${width}${dark ? '-dark' : ''}.png`), fullPage: true })
        expect(await page.evaluate(() => (window as any).sent.length)).toBe(1)
        await page.getByRole('button', { name: '交给工作台' }).click()
        expect(await page.evaluate(() => (window as any).handoff)).toContain('森林冒险')
        expect(await page.evaluate(() => (window as any).handoff)).not.toContain('modmind-followups')
        expect(await page.locator('.inspiration-followups button').count()).toBe(3)
        await page.locator('.inspiration-followups').scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.resolve(`test-results/inspiration-followups-${width}${dark ? '-dark' : ''}.png`), fullPage: true })
        expect(await page.evaluate(() => (window as any).sent[0])).toContain('<modmind-followups>')
        await page.getByRole('button', { name: '如何设计森林奖励？', exact: true }).click()
        await expect.poll(() => page.evaluate(() => (window as any).sent.length)).toBe(2)
        await page.locator('.inspiration-followups').waitFor()
        expect(await page.evaluate(() => (window as any).sent[1])).toContain('LATEST QUESTION\n如何设计森林奖励？')
        expect(await page.locator('.inspiration-followups button').count()).toBe(3)
        await page.getByRole('button', { name: '新建灵感对话' }).click()
        await options.first().waitFor()
        expect(await draft.inputValue()).toBe('')
        expect(await page.getByRole('combobox', { name: '切换灵感对话' }).locator('option:checked').textContent()).toMatch(/^新想法 \d+$/)
        await page.getByRole('combobox', { name: '切换灵感对话' }).selectOption({ index: 1 })
        await page.getByRole('button', { name: '交给工作台' }).last().waitFor()
      }
      expect(errors).toEqual([])
      await page.close()
    }
  } finally { await browser.close(); await server.close() }
}, 90_000)
