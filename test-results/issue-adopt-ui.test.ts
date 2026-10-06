import { expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

it('requires a target, retains manual corrections after failure, and fits a narrow window', async () => {
  const server = await createServer({ configFile: false, plugins: [{ name: 'isolate-adoption-dialog', enforce: 'pre', load(id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/renderer/src/App.tsx')) return
    const source = ts.createSourceFile(id, readFileSync(id, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['AdoptProjectDialog', 'errorMessage'].includes(node.name?.text ?? '')).map(node => `${ts.isFunctionDeclaration(node) && node.name?.text === 'AdoptProjectDialog' ? 'export ' : ''}${node.getText(source)}`).join('\n')
    return `import React, { useState } from 'react'; import { X, PackageOpen, CircleAlert, LoaderCircle } from 'lucide-react'; import { platformLabel } from '../../shared/projectPlatform'; import { reportClientFailure } from './lib/clientFailure';\n${functions}`
  } }, react()], optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(15_000)
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/issue-adopt-ui.html`)
    const submit = page.getByRole('button', { name: '接管此项目' })
    await submit.waitFor(); expect(await submit.isDisabled()).toBe(true)
    await page.getByLabel('Minecraft 版本', { exact: true }).selectOption('1.20.1')
    expect(await submit.isEnabled()).toBe(true)
    await submit.click()
    await expect.poll(() => page.evaluate(() => (window as any).calls[0]?.minecraftVersion)).toBe('1.20.1')
    await page.screenshot({ path: 'test-results/issue-adopt-desktop.png' })
    await page.reload()
    await page.getByLabel('Minecraft 版本', { exact: true }).selectOption('__manual__')
    expect(await submit.isDisabled()).toBe(true)
    await page.getByLabel('手动填写 Minecraft 版本').fill('1.21.4')
    await page.evaluate(() => { (window as any).fail = true })
    await submit.click(); await page.getByText('fixture adoption failure').waitFor()
    expect(await page.getByLabel('手动填写 Minecraft 版本').inputValue()).toBe('1.21.4')
    await page.setViewportSize({ width: 480, height: 720 })
    expect(await page.locator('.adopt-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/issue-adopt-narrow.png' })
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/issue-adopt-ui.html?unknown&dark`)
    expect(await submit.isDisabled()).toBe(true)
    await page.getByLabel('Minecraft 版本', { exact: true }).fill('1.20.1')
    expect(await submit.isEnabled()).toBe(true)
    await page.screenshot({ path: 'test-results/issue-adopt-unknown-dark.png' })
    expect(errors).toEqual([])
  } finally { await browser.close(); await server.close() }
}, 60_000)
