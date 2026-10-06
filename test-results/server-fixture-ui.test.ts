import { expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

it('keeps the existing panel quiet and completes isolated setup, polling, cancellation and retry in narrow/light/dark windows', async () => {
  const server = await createServer({ configFile: false, plugins: [{ name: 'isolate-server-panel', enforce: 'pre', load(id) {
    const normalized = id.replaceAll('\\', '/')
    if (/\/components\/(?:FtbQuestEditor|ImportModpackModule)\.tsx$/.test(normalized)) return 'export default function UnusedPage() { return null }'
    if (normalized.endsWith('/components/ServerPluginTools.tsx')) return 'export function ServerPluginSettings() { return null }'
    if (normalized.endsWith('/components/InteractionDialogs.tsx')) return 'export function useConfirmDialog() { return { confirm: async () => true, dialog: null } }'
  } }, react()], optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1160, height: 850 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/server-fixture-ui.html`)
    await page.getByText('运维与验证', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '运行隔离场景' }).isVisible()).toBe(false)
    await page.screenshot({ path: 'test-results/server-fixture-default.png' })
    await page.getByText('运维与验证', { exact: true }).click()
    await page.getByRole('button', { name: '隔离测试', exact: true }).click()
    const run = page.getByRole('button', { name: '运行隔离场景' })
    expect(await run.isDisabled()).toBe(true)
    await page.getByRole('button', { name: '选择 JAR' }).click()
    await page.getByLabel('步骤 1 等待上限（秒）').fill('20')
    await page.getByTitle('移除 dependency-one.jar').click()
    expect(await page.locator('.scenario-jars li').count()).toBe(2)
    await page.getByRole('button', { name: '选择 JAR' }).click()
    expect(await run.isEnabled()).toBe(true)
    await page.getByTitle('添加步骤').click()
    await page.getByLabel('步骤 2 操作').selectOption('restart')
    await page.screenshot({ path: 'test-results/server-fixture-desktop.png' })
    await run.click()
    await page.getByRole('button', { name: '取消测试' }).waitFor()
    const starts = await page.evaluate(() => (window as any).calls.filter((call: any) => call.operation === 'start'))
    expect(starts[0]).toMatchObject({ fixture: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.23', jars: expect.any(Array) }, steps: [expect.any(Object), { operation: 'restart' }] })
    await page.evaluate(() => { (window as any).failPoll = true })
    await page.getByTitle('重新查询测试进度').waitFor()
    await page.evaluate(() => { (window as any).failPoll = false })
    await page.getByTitle('重新查询测试进度').click()
    await page.getByRole('button', { name: '取消测试' }).click()
    await page.getByText('隔离测试已取消', { exact: true }).waitFor()
    expect(await run.isEnabled()).toBe(true)
    await page.setViewportSize({ width: 480, height: 760 })
    expect(await page.locator('.modpack-tool-workspace').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/server-fixture-narrow.png', fullPage: true })
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/server-fixture-ui.html?dark`)
    await page.getByText('运维与验证', { exact: true }).click()
    await page.getByRole('button', { name: '隔离测试', exact: true }).click()
    await page.getByRole('button', { name: '选择 JAR' }).click()
    expect(await page.locator('.server-scenario-controls').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/server-fixture-dark.png', fullPage: true })
    expect(errors).toEqual([])
  } finally { await browser.close(); await server.close() }
}, 60000)
