const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { build } = require('esbuild')
const { chromium } = require('playwright')

;(async () => {
  const directory = path.resolve('test-results/image-workflows')
  await fs.mkdir(directory, { recursive: true })
  await build({ stdin: { contents: `
    import React, {useState,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
    import ImageStudioWorkspace from './src/renderer/src/components/ImageStudioWorkspace';
    import * as storage from './src/renderer/src/lib/imageWorkflowStorage';
    import './src/renderer/src/theme-tokens.css';
    import './src/renderer/src/styles.css';
    import './src/renderer/src/workspace-chrome.css';
    import './src/renderer/src/palette.css';
    import {applyAppearance} from './src/renderer/src/theme';
    window.workflowStorage = storage;
    window.requests = []; window.failAt = 0; window.pauseAt = 0;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
    window.modmind = {imageStudio:{getSettings:async()=>({hasStoredKey:true,model:'test'}),capabilities:async()=>({models:['test'],sizes:['1024x1024'],qualities:['low','medium'],moderations:['auto']}),generate:async request=>{
      window.requests.push(request); await new Promise(r=>setTimeout(r,100));
      if(window.pauseAt===window.requests.length) await new Promise(resolve=>{window.releaseImage=resolve});
      if(window.failAt===window.requests.length) throw Error('模拟上游失败');
      return {jobId:'job',assets:[{id:crypto.randomUUID(),dataUrl:png,model:'test',credits:0,hosted:false,createdAt:'',style:'free',quality:'medium',size:'1024x1024'}]};
    },process:async(_,dataUrl)=>({dataUrl})},project:{listImageAssets:async()=>[]}};
    function App(){const [visible,setVisible]=useState(true);const [dark,setDark]=useState(false);useEffect(()=>applyAppearance({darkMode:dark,themePreset:'neutral'}),[dark]);return <div className={'app-shell '+(dark?'dark-mode':'')} style={{display:'block',height:'100vh'}}><button id="toggle-visible" style={{position:'absolute',top:0,right:0,zIndex:100}} onClick={()=>setVisible(!visible)}>切换可见</button><button id="toggle-dark" style={{position:'absolute',top:0,right:90,zIndex:100}} onClick={()=>setDark(!dark)}>主题</button><div className="image-studio-host" hidden={!visible} style={{height:'100%'}}><ImageStudioWorkspace visible={visible} darkMode={dark} onOpenSettings={()=>{}} /></div></div>};
    createRoot(document.getElementById('root')).render(<App/>);
  `, loader: 'tsx', resolveDir: process.cwd() }, outfile: path.join(directory, 'app.js'), bundle: true, jsx: 'automatic', sourcemap: false, define: { 'import.meta.env': '{}', 'import.meta.hot': 'undefined' } })
  const server = http.createServer(async (req, res) => {
    const file = req.url === '/app.js' ? 'app.js' : req.url === '/app.css' ? 'app.css' : null
    res.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html')
    res.end(file ? await fs.readFile(path.join(directory, file)) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const toolbar = page.locator('.image-workflow-library')
    const picker = toolbar.getByRole('combobox', { name: '已保存的工作流' })
    const currentName = page.locator('.image-workflow-picker-trigger .image-workflow-name')
    const waitSaved = () => page.waitForFunction(() => !document.querySelector('.image-workflow-save-state') && !document.querySelector('[aria-label="已保存的工作流"]')?.disabled)
    const switchTo = async name => { await picker.click(); await page.getByRole('option').filter({ hasText: name }).click(); await waitSaved() }
    const initialName = '一个悬浮在深色石台上的蓝色水晶物品图标'
    await toolbar.getByRole('button', { name: '保存', exact: true }).click()
    await waitSaved()
    assert.equal(await currentName.textContent(), initialName)
    assert.equal(await page.getByRole('dialog').count(), 0, 'saving uses the first prompt without a naming dialog')
    // Fail the second single-image call: the first output stays visible and savable.
    assert.equal(await page.locator('.image-workflow-sidebar').count(), 0, 'inspector stays closed until a node is selected')
    await page.locator('.react-flow__node').filter({ hasText: '图像生成' }).first().click()
    await page.locator('.field-label').filter({ hasText: '批量数量' }).locator('input').fill('3')
    await page.evaluate(() => { window.failAt = 2; window.pauseAt = 2 })
    await page.getByRole('button', { name: '运行工作流', exact: true }).click()
    await page.waitForFunction(() => Boolean(window.releaseImage))
    assert.equal(await page.locator('.image-output-preview').count(), 1, 'first image must render while the second request is pending')
    assert.equal(await picker.isDisabled(), true)
    assert.equal(await page.locator('.image-workflow-node-output').count(), 3, 'all result frames exist while generation is pending')
    assert.equal(await page.locator('.image-output-loading').count(), 2)
    const firstRound = await page.locator('.react-flow__node').filter({ has: page.locator('.image-workflow-node-output') }).evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.id, transform: node.style.transform, height: node.getBoundingClientRect().height })))
    await page.evaluate(() => window.releaseImage())
    await page.getByRole('status').filter({ hasText: '模拟上游失败' }).waitFor()
    assert.equal(await page.locator('.image-output-preview').count(), 1)
    assert.equal(await page.locator('.image-output-loading').count(), 0, 'failed requests leave no infinite spinners')
    assert.equal(await page.locator('.image-output-error').count(), 2)
    assert.deepEqual(await page.evaluate(() => window.requests.map(r => r.count)), [1, 1])
    // A second round appears in a new column and keeps each frame stationary as images arrive.
    await page.evaluate(() => { window.failAt = 0; window.pauseAt = 3; window.releaseImage = null })
    await page.getByRole('button', { name: '运行工作流', exact: true }).click()
    await page.waitForFunction(() => Boolean(window.releaseImage))
    const secondRound = await page.locator('.react-flow__node').filter({ has: page.locator('.image-workflow-node-output[aria-busy="true"]') }).evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.id, transform: node.style.transform, height: node.getBoundingClientRect().height })))
    assert.equal(secondRound.length, 3)
    const position = transform => [...transform.matchAll(/-?[\d.]+/g)].map(value => Number(value[0]))
    assert.ok(position(secondRound[0].transform)[0] > position(firstRound[0].transform)[0])
    assert.equal(new Set(secondRound.map(node => position(node.transform)[0])).size, 1)
    assert.ok(position(secondRound[1].transform)[1] > position(secondRound[0].transform)[1])
    await page.screenshot({ path: path.join(directory, 'loading-results.png') })
    const viewportBefore = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.evaluate(() => window.releaseImage())
    await page.getByRole('status').filter({ hasText: '工作流完成' }).waitFor()
    assert.equal(await page.locator('.image-output-preview').count(), 4)
    assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), viewportBefore, 'filling a result must not move the camera')
    for (const result of secondRound) {
      const current = page.locator(`.react-flow__node[data-id="${result.id}"]`)
      assert.equal(await current.evaluate(node => node.style.transform), result.transform)
      assert.ok(Math.abs((await current.boundingBox()).height - result.height) < 1, 'loading and completed frames share the same height')
    }
    assert.deepEqual(await page.evaluate(() => window.requests.map(r => r.count)), [1, 1, 1, 1, 1])
    // New nodes follow the visible centre after panning/zooming, and avoid all existing nodes.
    await toolbar.getByText('添加节点', { exact: true }).click()
    await toolbar.getByRole('button', { name: '提示词', exact: true }).click()
    const added = page.locator('.react-flow__node.selected')
    const addedBounds = await added.boundingBox()
    const canvasBounds = await page.locator('.image-workflow-canvas').boundingBox()
    await page.waitForFunction(() => {
      const node = document.querySelector('.react-flow__node.selected')?.getBoundingClientRect()
      const canvas = document.querySelector('.image-workflow-canvas')?.getBoundingClientRect()
      return node && canvas && Math.abs(node.x + node.width / 2 - canvas.x - canvas.width / 2) < 15
    })
    assert.ok(addedBounds && canvasBounds)
    assert.equal(await added.evaluate(node => {
      const box = node.getBoundingClientRect()
      return [...document.querySelectorAll('.react-flow__node')].filter(other => other !== node).some(other => {
        const rect = other.getBoundingClientRect()
        return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
      })
    }), false, 'new nodes never overlap existing cards')
    const beforeDelete = await page.locator('.react-flow__node').count()
    await page.keyboard.press('Delete')
    assert.equal(await page.locator('.react-flow__node').count(), beforeDelete - 1)
    await page.keyboard.press('Delete')
    assert.equal(await page.locator('.react-flow__node').count(), beforeDelete - 1, 'deleting does not select and delete the next node')
    await toolbar.locator('.image-workflow-menu > summary').click()
    await toolbar.getByRole('button', { name: '另存为新工作流' }).click()
    await waitSaved()
    assert.equal(await page.evaluate(async () => (await window.workflowStorage.loadImageWorkflows()).workflows.length), 2)
    await page.locator('.react-flow__node').filter({ hasText: '提示词' }).first().click()
    await page.locator('textarea').fill('只属于第二套的描述')
    await page.locator('#toggle-visible').click(); await page.locator('#toggle-visible').click()
    assert.equal(await page.locator('textarea').inputValue(), '只属于第二套的描述')
    assert.equal(await currentName.textContent(), '只属于第二套的描述')
    await switchTo(initialName)
    await page.locator('.react-flow__node').filter({ hasText: '提示词' }).first().click()
    assert.notEqual(await page.locator('textarea').inputValue(), '只属于第二套的描述')
    await switchTo('只属于第二套的描述')
    await page.locator('.react-flow__node').filter({ hasText: '提示词' }).first().click()
    assert.equal(await page.locator('textarea').inputValue(), '只属于第二套的描述')
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.image-workflow-picker-trigger .image-workflow-name')?.textContent === '只属于第二套的描述')
    assert.equal(await page.locator('.image-output-preview').count(), 4)
    await page.locator('.react-flow__node').filter({ hasText: '提示词' }).first().click()
    const longName = '为森林村落制作一组温暖的像素风材质，保留木纹和自然光照，适合用于建造冒险地图中的旅馆与工作台'
    await page.locator('textarea').fill(longName)
    await toolbar.getByRole('button', { name: '保存', exact: true }).click()
    await waitSaved()
    assert.equal(await currentName.textContent(), longName)
    assert.ok(await currentName.evaluate(element => element.classList.contains('is-overflowing')))
    // Keyboard navigation and Escape return focus to the switcher.
    await picker.focus(); await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor()
    await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('Escape')
    assert.equal(await picker.getAttribute('aria-expanded'), 'false')
    assert.equal(await picker.evaluate(element => element === document.activeElement), true)
    for (const dark of [false, true]) {
      if (dark) await page.locator('#toggle-dark').click()
      for (const width of [1280, 800, 480]) {
        await page.setViewportSize({ width, height: 900 })
        await page.screenshot({ path: path.join(directory, `${dark ? 'dark' : 'light'}-${width}.png`), fullPage: true })
        assert.ok(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `toolbar overflow at ${width}`)
        await picker.click()
        await page.screenshot({ path: path.join(directory, `switcher-${dark ? 'dark' : 'light'}-${width}.png`), fullPage: true })
        const popup = await page.locator('.image-workflow-picker-popover').boundingBox()
        assert.ok(popup.x >= 0 && popup.x + popup.width <= width, `switcher fits at ${width}`)
        await page.keyboard.press('Escape')
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await toolbar.locator('.image-workflow-menu > summary').click()
    await toolbar.getByRole('button', { name: '删除工作流', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
    await waitSaved()
    assert.equal(await page.evaluate(async () => (await window.workflowStorage.loadImageWorkflows()).workflows.length), 1)
    // Real IndexedDB transactions: stale writes cannot overwrite newer saves.
    assert.equal(await page.evaluate(async () => {
      const old = await window.workflowStorage.loadImageWorkflows()
      await window.workflowStorage.saveImageWorkflows(old)
      try { await window.workflowStorage.saveImageWorkflows(old); return false } catch (error) { return error.message.includes('其他窗口') }
    }), true)
    // A fresh browser profile migrates the original single-workflow entry without deleting its backup.
    const context = await browser.newContext()
    const migrated = await context.newPage()
    await migrated.addInitScript(() => localStorage.setItem('modmind.image-studio.workflow.v1', JSON.stringify({
      nodes: [{ id: 'legacy-p', position: { x: 0, y: 0 }, data: { kind: 'prompt', title: '提示词', subtitle: '', prompt: '旧版描述' } }, { id: 'legacy-g', position: { x: 200, y: 0 }, data: { kind: 'generate', title: '图像生成', subtitle: '', count: 1 } }], edges: [{ id: 'legacy-edge', source: 'legacy-p', target: 'legacy-g' }]
    })))
    await migrated.goto(`http://127.0.0.1:${server.address().port}`)
    await migrated.waitForFunction(() => document.querySelector('.image-workflow-picker-trigger .image-workflow-name')?.textContent === '旧版描述')
    assert.equal(await migrated.evaluate(async () => (await window.workflowStorage.loadImageWorkflows()).workflows[0].nodes[0].data.prompt), '旧版描述')
    assert.ok(await migrated.evaluate(() => localStorage.getItem('modmind.image-studio.workflow.v1')))
    await context.close()
    // Stop keeps the in-flight image and marks the remaining preallocated slots as stopped.
    const stopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const stopped = await stopContext.newPage()
    await stopped.goto(`http://127.0.0.1:${server.address().port}`)
    await stopped.locator('.react-flow__node').filter({ hasText: '图像生成' }).click()
    await stopped.locator('.field-label').filter({ hasText: '批量数量' }).locator('input').fill('3')
    await stopped.evaluate(() => { window.pauseAt = 1 })
    await stopped.getByRole('button', { name: '运行工作流', exact: true }).click()
    await stopped.waitForFunction(() => Boolean(window.releaseImage))
    assert.equal(await stopped.locator('.image-output-loading').count(), 3)
    await stopped.getByRole('button', { name: '完成当前请求后停止' }).click()
    await stopped.evaluate(() => window.releaseImage())
    await stopped.locator('.image-output-cancelled').first().waitFor()
    assert.equal(await stopped.locator('.image-output-preview').count(), 1)
    assert.equal(await stopped.locator('.image-output-cancelled').count(), 2)
    assert.equal(await stopped.locator('.image-output-loading').count(), 0)
    assert.equal(await stopped.evaluate(() => window.requests.length), 1)
    await stopContext.close()
    // Clipboard events exercise the actual paste handler without overwriting the user's OS clipboard.
    const pasteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const pasted = await pasteContext.newPage()
    pasted.on('pageerror', error => errors.push(error.message))
    await pasted.goto(`http://127.0.0.1:${server.address().port}`)
    await pasted.waitForFunction(() => !document.querySelector('.image-workflow-picker-trigger')?.disabled)
    const paste = (text = '', image = false, target = '.image-workflow-canvas') => pasted.evaluate(({ text, image, target }) => {
      const clipboardData = new DataTransfer()
      if (text) clipboardData.setData('text/plain', text)
      if (image) {
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='), char => char.charCodeAt(0))
        clipboardData.items.add(new File([png], 'clipboard.png', { type: 'image/png' }))
      }
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
      document.querySelector(target).dispatchEvent(event)
      return event.defaultPrevented
    }, { text, image, target })
    const prompt = '  一座森林里的小木屋\n暖色灯光，像素风格  '
    assert.equal(await paste(prompt), true)
    await pasted.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 4)
    assert.equal(await pasted.locator('textarea').inputValue(), prompt)
    assert.equal(await paste('正常编辑输入框', false, 'textarea'), false)
    assert.equal(await pasted.locator('.react-flow__node').count(), 4)
    assert.equal(await paste('https://example.test/image.png', true), true)
    await pasted.locator('.image-reference-thumb').waitFor()
    assert.equal(await pasted.locator('.react-flow__node').count(), 5, 'image plus text creates exactly one reference node')
    assert.ok((await pasted.locator('.image-reference-thumb').getAttribute('src')).startsWith('data:image/png;base64,'))
    assert.equal(await pasted.locator('.react-flow__node.selected .image-workflow-node-reference').count(), 1)
    assert.equal(await pasted.locator('.react-flow__node.selected').evaluate(node => {
      const box = node.getBoundingClientRect()
      return [...document.querySelectorAll('.react-flow__node')].filter(other => other !== node).some(other => {
        const rect = other.getBoundingClientRect()
        return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
      })
    }), false)
    assert.equal(await paste('   \n  '), false)
    assert.equal(await paste('字'.repeat(32001)), true)
    assert.equal(await pasted.locator('.react-flow__node').count(), 5)
    await pasted.getByRole('tab', { name: '处理', exact: true }).click()
    assert.equal(await paste('不应该新建节点', false, '.image-studio-page'), false)
    await pasted.getByRole('tab', { name: '工作流', exact: true }).click()
    await pasted.locator('#toggle-visible').click()
    assert.equal(await paste('隐藏工作区不应粘贴', false, 'body'), false)
    await pasted.locator('#toggle-visible').click()
    await pasted.locator('.image-workflow-library').getByRole('button', { name: '保存', exact: true }).click()
    await pasted.waitForFunction(() => !document.querySelector('.image-workflow-save-state') && !document.querySelector('[aria-label="已保存的工作流"]')?.disabled)
    await pasted.reload()
    await pasted.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 5)
    const savedPaste = await pasted.evaluate(async () => (await window.workflowStorage.loadImageWorkflows()).workflows[0])
    assert.ok(savedPaste.nodes.some(node => node.data.prompt === prompt))
    assert.ok(savedPaste.nodes.some(node => node.data.kind === 'reference' && node.data.referenceImage?.startsWith('data:image/png;base64,')))
    assert.equal(await pasted.evaluate(() => window.requests.length), 0, 'pasting never starts generation')
    await pasteContext.close()
    // Presets stay local to their generator, persist edits and never trigger paid work on selection.
    const presetContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const presetPage = await presetContext.newPage()
    presetPage.on('pageerror', error => errors.push(error.message))
    await presetPage.goto(`http://127.0.0.1:${server.address().port}`)
    await presetPage.locator('.react-flow__node[data-id="generate-1"]').click()
    const presets = presetPage.getByRole('combobox', { name: '预设', exact: true })
    assert.equal(await presets.locator('optgroup option').count(), 15)
    assert.equal(await presets.inputValue(), 'minecraft', 'legacy style is preserved')
    await presets.selectOption('creature-views')
    const template = presetPage.getByRole('textbox', { name: '预设提示词（可编辑）', exact: true })
    assert.ok((await template.inputValue()).includes('正交投影'))
    const edited = (await template.inputValue()).replace('苔藓石像守卫', '铜制机器人')
    await template.fill(edited)
    assert.equal(await presetPage.evaluate(() => window.requests.length), 0)
    await presetPage.getByRole('button', { name: '保存', exact: true }).click()
    await presetPage.waitForFunction(() => !document.querySelector('.image-workflow-save-state') && !document.querySelector('[aria-label="已保存的工作流"]')?.disabled)
    await presetPage.reload()
    await presetPage.locator('.react-flow__node[data-id="generate-1"]').click()
    assert.equal(await presets.inputValue(), 'creature-views')
    assert.equal(await template.inputValue(), edited)
    const presetSaved = await presetPage.evaluate(async () => (await window.workflowStorage.loadImageWorkflows()).workflows[0])
    assert.equal(presetSaved.nodes.find(node => node.id === 'prompt-1').data.prompt, initialName)
    for (const dark of [false, true]) {
      if (dark) await presetPage.locator('#toggle-dark').click()
      for (const width of [1280, 780, 390]) {
        await presetPage.setViewportSize({ width, height: 900 })
        await template.scrollIntoViewIfNeeded()
        assert.ok(await presetPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'preset inspector must not overflow horizontally')
        await presetPage.screenshot({ path: path.join(directory, `presets-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true })
      }
    }
    await presetPage.setViewportSize({ width: 1280, height: 900 })
    await presets.selectOption('machine-state')
    await presetPage.getByRole('button', { name: '运行工作流', exact: true }).click()
    await presetPage.getByRole('status').filter({ hasText: '需要参考图' }).waitFor()
    assert.equal(await presetPage.evaluate(() => window.requests.length), 0, 'missing reference fails before calling the image service')
    await presets.selectOption('creature-views')
    await template.fill(edited)
    await presetPage.getByRole('button', { name: '运行工作流', exact: true }).click()
    await presetPage.waitForFunction(() => window.requests.length === 1)
    const presetRequest = await presetPage.evaluate(() => window.requests[0])
    assert.ok(presetRequest.prompt.includes(edited))
    assert.ok(presetRequest.prompt.includes(initialName))
    assert.equal(presetRequest.style, 'free', 'templates must not inherit the legacy pixel-art prefix')
    await presetPage.getByRole('button', { name: '运行工作流', exact: true }).waitFor({ state: 'visible' })
    await presetPage.waitForFunction(() => !document.querySelector('.image-workflow-fields')?.disabled)
    await presets.selectOption('free')
    assert.equal(await template.count(), 0)
    await presetContext.close()
    assert.deepEqual(errors, [])
    console.log('Passed: text/image paste, input/hidden/tab isolation, clipboard persistence, immediate loading frames, incremental filling, stable camera/card sizes, rightward rounds, centred collision-free new nodes, safe deletion, prompt names, keyboard switcher, save/copy/switch/reload/delete, failure preservation, IndexedDB conflict protection and six theme/size layouts.')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
