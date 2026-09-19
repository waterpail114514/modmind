const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')
const { chromium } = require('playwright')

;(async () => {
  const root = path.resolve('test-results/image-studio-recorder-smoke', String(Date.now()))
  await fs.mkdir(root, { recursive: true })
  await build({ entryPoints: ['scripts/image-studio-recorder.ts'], outfile: path.join(root, 'recorder.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const child = spawn(process.execPath, [path.join(root, 'recorder.mjs')], { env: { ...process.env, MODMIND_IMAGE_LOG_ROOT: root, MODMIND_IMAGE_LOG_PORT: '43188' }, windowsHide: true, stdio: 'pipe' })
  let browser
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Recorder exited: ${code}`)))
    })
    const info = await (await fetch('http://127.0.0.1:43188/status')).json()
    assert.equal((await fetch('http://127.0.0.1:43188/events', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './src/renderer/src/components/ImageStudioWorkspace';
      import './src/renderer/src/theme-tokens.css'; import './src/renderer/src/styles.css';
      window.calls=0;
      window.modmind={imageStudio:{getSettings:async()=>({hasStoredKey:true}),capabilities:async()=>({models:['test'],sizes:['1024x1024'],qualities:['medium'],moderations:['auto']}),
        generate:async request=>{window.calls++;return {jobId:'test',credits:0,hosted:false,assets:[{id:'test-'+window.calls,dataUrl:'data:image/png;base64,AA==',style:'free',size:'1024x1024',quality:'medium',createdAt:'',hosted:false,credits:0,model:'test'}]}},
        process:async()=>{throw Error('test process error')}},project:{listImageAssets:async()=>[]}};
      createRoot(document.getElementById('root')).render(<Workspace visible={true} darkMode={false} onOpenSettings={()=>{}}/>);
    `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, jsx: 'automatic', outfile: path.join(root, 'app.js'), define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_IMAGE_TRACE': JSON.stringify('1'), 'import.meta.env.VITE_IMAGE_LOG_ENDPOINT': JSON.stringify('http://127.0.0.1:43188'), 'import.meta.hot': 'undefined' } })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
    await page.route('http://localhost:5173/**', async route => {
      const file = route.request().url().endsWith('app.js') ? 'app.js' : route.request().url().endsWith('app.css') ? 'app.css' : null
      await route.fulfill({ contentType: file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html', body: file ? await fs.readFile(path.join(root, file)) : '<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>' })
    })
    await page.goto('http://localhost:5173')
    await page.getByRole('button', { name: '运行工作流', exact: true }).waitFor()
    await page.locator('.react-flow__node').filter({ hasText: '图像生成' }).click()
    await page.locator('.field-label').filter({ hasText: '批量数量' }).locator('input').fill('3')
    await page.getByRole('button', { name: '运行工作流', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '工作流完成' }).waitFor()
    await page.getByTitle('删除当前节点', { exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.imageRecording === 'recording')
    const events = (await fs.readFile(path.join(info.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
    const run = events.find(event => event.type === 'workflow.run.start')
    assert.ok(run?.runId)
    assert.equal(run.data.plan.totalCount, 3)
    const starts = events.filter(event => event.type === 'api.start' && event.data.operation === 'generate')
    const successes = events.filter(event => event.type === 'api.success' && event.data.operation === 'generate')
    assert.equal(starts.length, 3)
    assert.equal(successes.length, 3)
    assert.ok(starts.every(event => event.runId === run.runId && event.data.nodeId === 'generate-1' && event.data.args[0].count === 1))
    assert.deepEqual(events.find(event => event.type === 'node.delete').data.deletedIds, ['generate-1'])
    assert.ok(events.some(event => event.type === 'ui.interaction' && event.data.event === 'input'))
    const snapshots = events.filter(event => event.type === 'workspace.snapshot')
    assert.ok(snapshots.some(event => event.data.nodes.some(node => node.id === 'generate-1')))
    assert.ok(!snapshots.at(-1).data.nodes.some(node => node.id === 'generate-1'))
    assert.ok(events.some(event => event.type === 'image.register' && event.data.dataUrl.file))
    assert.deepEqual(errors, [])
    console.log('Passed: live UI recording, input, complete graph snapshots, run/node/request correlation, three API results, exact deletion IDs, image persistence and origin rejection.')
  } finally { if (browser) await browser.close(); child.kill() }
})().catch(error => { console.error(error); process.exitCode = 1 })
