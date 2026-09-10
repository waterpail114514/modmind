import path from 'node:path'
import { promises as fs } from 'node:fs'
import { test, expect } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFtbQuestBook } from '../src/main/ftbQuestBookService'
import { inspectFtbQuestIcon, resolveFtbQuestShapes, resolveFtbQuestDependencyTexture, resolveFtbQuestItemNames } from '../src/main/ftbquesticonservice'
import type { ProjectInfo } from '../src/shared/types'

test('real pack editor requests and renders mounted quest icons', async () => {
  const projectPath = process.env.FTB_AUDIT_PROJECT!
  expect(projectPath).toBeTruthy()
  const project: ProjectInfo = { ...JSON.parse(await fs.readFile(path.join(projectPath, 'modmind.project.json'), 'utf8')), path: projectPath }
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], optimizeDeps: { entries: ['test-results/ftb-editor-ui.html'] }, server: { host: '127.0.0.1', port: 5200, strictPort: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  let iconRequests = 0
  let returnedIcons = 0
  const pending = new Map<number, unknown>()
  await page.exposeFunction('backend', async (method: string, args: unknown[]) => {
    if (method === 'readFtbQuestBook') return readFtbQuestBook(project)
    if (method === 'inspectFtbQuestIcon') {
      const request = ++iconRequests; pending.set(request, args[0])
      try { const result = await inspectFtbQuestIcon(project, args[0], args[2] === true); if (result.icon) returnedIcons++; return result }
      finally { pending.delete(request) }
    }
    if (method === 'ftbQuestShapes') return resolveFtbQuestShapes(project)
    if (method === 'ftbDependencyTexture') return resolveFtbQuestDependencyTexture(project)
    if (method === 'ftbQuestItemNames') return resolveFtbQuestItemNames(project, args[0] as string[])
    if (method === 'listFtbQuestBackups') return []
    throw new Error(`Unexpected write/UI call: ${method}`)
  })
  await page.addInitScript(value => { (window as any).project = value }, project)
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/ftb-editor-ui.html`)
    await page.locator('.react-flow__node').first().waitFor()
    await expect.poll(() => iconRequests, { timeout: 25_000 }).toBeGreaterThan(0)
    await expect.poll(() => returnedIcons, { timeout: 35_000 }).toBeGreaterThan(0)
    await expect.poll(async () => await page.locator('.ftb-quest-tile-img').count(), { timeout: 35_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(12_000)
    const loading = await page.locator('.ftb-quest-tile .spin').count()
    const tiles = await page.locator('.ftb-quest-tile').count()
    await page.screenshot({ path: path.resolve('test-results/ftb-real-editor-icons.png'), fullPage: true })
    console.log({ iconRequests, returnedIcons, loading, tiles, pending: [...pending.values()] })
    expect(loading).toBe(0)
  } finally { await browser.close(); await server.close() }
}, 120000)
