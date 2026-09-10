import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFtbQuestBook, saveFtbQuestBook, listFtbQuestBackups, restoreFtbQuestBackup } from '../src/main/ftbQuestBookService'
import { inspectFtbQuestIcon, refreshFtbQuestResources, resolveFtbQuestShapes, resolveFtbQuestDependencyTexture, resolveFtbQuestItemNames } from '../src/main/ftbquesticonservice'
import type { ProjectInfo } from '../src/shared/types'

test('actual editor interactions against a temporary book and real main services', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-ftb-gui-'))
  const project: ProjectInfo = { path: root, kind: 'modpack', name: 'GUI fixture', namespace: 'fixture', minecraftVersion: '1.20.1', loader: 'forge', createdAt: new Date().toISOString() }
  const chapters = path.join(root, 'overrides/config/ftbquests/quests/chapters')
  await fs.mkdir(chapters, { recursive: true })
  await fs.writeFile(path.join(chapters, 'one.snbt'), '{id:"C1",title:"First Chapter",quests:[{id:"Q1",title:"First Quest",icon:{id:"minecraft:diamond",Count:1b,tag:{CustomModelData:7}},x:0.5d,y:0,tasks:[{id:"T1",type:"item",item:"minecraft:stone"}]}]}')
  await fs.writeFile(path.join(chapters, 'two.snbt'), '{id:"C2",title:"Second Chapter",quests:[{id:"Q2",title:"Second Quest",icon:"minecraft:book",x:0,y:0,dependencies:["Q1"]}]}')
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()], optimizeDeps: { entries: ['test-results/ftb-editor-ui.html'] }, server: { host: '127.0.0.1', port: 5199, strictPort: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', error => { errors.push(error.message); console.log('page-error', error.message) })
  let reads = 0
  await page.exposeFunction('backend', async (method: string, args: any[]) => {
    if (method === 'readFtbQuestBook') { reads++; return readFtbQuestBook(project) }
    if (method === 'saveFtbQuestBook') return saveFtbQuestBook(project, args[0])
    if (method === 'listFtbQuestBackups') return listFtbQuestBackups(project)
    if (method === 'restoreFtbQuestBackup') return restoreFtbQuestBackup(project, args[1], args[2])
    if (method === 'inspectFtbQuestIcon') return inspectFtbQuestIcon(project, args[0], args[2])
    if (method === 'refreshFtbQuestResources') return refreshFtbQuestResources(project, args[1])
    if (method === 'ftbQuestShapes') return resolveFtbQuestShapes(project)
    if (method === 'ftbDependencyTexture') return resolveFtbQuestDependencyTexture(project)
    if (method === 'ftbQuestItemNames') return resolveFtbQuestItemNames(project, args[0])
    throw new Error(method)
  })
  await page.addInitScript(value => { (window as any).project = value }, project)
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}test-results/ftb-editor-ui.html`)
    const node = page.locator('.react-flow__node').first()
    await node.waitFor()
    await node.click()
    const dialog = page.getByRole('dialog', { name: '任务详情' })
    await dialog.waitFor()
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    const title = dialog.locator('.ftb-quest-book-title')
    await title.fill('Edited Quest')
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.screenshot({ path: path.resolve('test-results/ftb-editor-desktop.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await node.click()
    expect(await title.inputValue()).toBe('First Quest')
    await title.fill('Saved Quest')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await page.getByRole('alertdialog').waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    expect(reads).toBe(1)
    await page.getByRole('button', { name: '保存任务书', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ftb-quest-message')?.textContent?.includes('已保存'))
    expect((await readFtbQuestBook(project)).chapters[0].quests[0].title).toBe('Saved Quest')
    expect((await readFtbQuestBook(project)).chapters[0].quests[0].x).toBe(.5)
    expect(reads).toBe(1)
    await page.getByRole('button', { name: 'Second Chapter 1 个任务' }).click()
    await page.locator('.react-flow__node').first().click()
    await page.getByRole('button', { name: '查看前置任务', exact: true }).click()
    expect(await title.inputValue()).toBe('Saved Quest')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '备份恢复', exact: true }).click()
    await page.getByRole('button', { name: '恢复', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '恢复', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ftb-quest-message')?.textContent?.includes('已恢复'))
    expect((await readFtbQuestBook(project)).chapters[0].quests[0].title).toBe('First Quest')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.react-flow__node').first().click()
    await page.screenshot({ path: path.resolve('test-results/ftb-editor-mobile.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } catch (error) { await page.screenshot({ path: path.resolve('test-results/ftb-editor-failure.png'), fullPage: true }); console.log((await page.locator('body').innerText()).slice(0, 3000)); throw error }
  finally { await browser.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }) }
}, 120000)
