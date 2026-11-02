import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results', 'contribution-ui', String(Date.now()))
const profile = path.join(work, 'profile'), project = path.join(os.tmpdir(), 'modmind-contribution-qa-' + path.basename(work)), output = path.join(work, 'build')
await mkdir(profile, { recursive: true }); await mkdir(project, { recursive: true })
await writeFile(path.join(profile, 'service-config.json'), '{}')
await writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: '贡献设置验证', namespace: 'contribution_qa', kind: 'modpack', loader: 'fabric', minecraftVersion: '1.20.1', path: project, createdAt: new Date().toISOString(), projectVersion: '0.1.0' }))
await writeFile(path.join(profile, 'current-project.json'), JSON.stringify({ path: project }))
await cp(path.join(root, 'out'), output, { recursive: true })
const mainFile = path.join(output, 'main', 'index.js')
const mainSource = await readFile(mainFile, 'utf8')
assert.ok(mainSource.includes('let contributionService'))
await writeFile(mainFile, mainSource + '\nexports.__contributionQa = {flush: () => contributionService.flush()};\n')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `
const {app}=require('electron');app.setName('modmind-contribution-smoke-${Date.now()}');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});
const undici=require(${JSON.stringify(path.join(root, 'node_modules/undici'))});
globalThis.__contributionQa={offline:false,calls:[],uploads:[]};
const expiresAt=new Date(Date.now()+7*86400000).toISOString();
const ticket={format:'modmind-contribution-upload',schemaVersion:1,expiresAt,url:'https://cn-nb1.rains3.com/contribute',maxBytes:65536,fields:{'Content-Type':'application/json',bucket:'contribute',key:'\u0024{filename}','X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':'EXAMPLEACCESS1234/20261101/rainyun/s3/aws4_request','X-Amz-Date':'20261101T000000Z','X-Amz-Signature':'0'.repeat(64),Policy:Buffer.from(JSON.stringify({expiration:expiresAt,conditions:[{bucket:'contribute'},['starts-with','\u0024key',''],['content-length-range',1,65536]]})).toString('base64')}};
undici.fetch=async(url,options)=>{
 const value=String(url);if(value.includes('contributions/upload-ticket.json')||value==='https://cn-nb1.rains3.com/contribute'){
  globalThis.__contributionQa.calls.push(value);if(globalThis.__contributionQa.offline)throw Error('QA offline');
  if(value.includes('upload-ticket.json'))return new Response(JSON.stringify(ticket),{status:200});
  const form=options.body;globalThis.__contributionQa.uploads.push({key:form.get('key'),report:JSON.parse(await form.get('file').text())});return new Response(null,{status:204});
 }
 throw Error('QA external networking disabled');
};
globalThis.__contributionQa.module=require(${JSON.stringify(mainFile)});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let app, page, child, reader
const errors = []
try {
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], cwd: root, env, timeout: 60000 })
  page = await app.firstWindow({ timeout: 60000 }); page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.modmind?.contributions))
  await page.locator('#app-loading').waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.setSize(1280, 800)))
  assert.equal((await page.evaluate(() => window.modmind.contributions.getState())).enabled, false)
  const immediate = await page.evaluate(async () => {
    const c = await window.modmind.contributions.beginConsent()
    try { await window.modmind.contributions.enable(c.token, c.termsVersion); return false } catch { return true }
  })
  assert.equal(immediate, true)
  if (await page.locator('.expert-mode-toggle').isVisible() && !await page.getByRole('checkbox', { name: '专业模式', exact: true }).isChecked()) await page.locator('.expert-mode-toggle').click()
  await page.getByRole('button', { name: '直接进入工作台', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('自动上传')
  await page.getByRole('switch', { name: '自动贡献使用统计' }).waitFor()
  await page.screenshot({ path: path.join(work, 'settings-light-desktop.png') })
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('')
  await page.getByRole('switch', { name: '深色模式', exact: true }).click()
  await page.locator('.app-shell.dark-mode').waitFor()
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('贡献')
  const toggle = page.getByRole('switch', { name: '自动贡献使用统计' })
  await toggle.scrollIntoViewIfNeeded(); await toggle.waitFor()
  await page.screenshot({ path: path.join(work, 'settings-desktop.png') })
  await toggle.click()
  const dialog = page.getByRole('dialog', { name: '数据贡献使用条例' })
  await dialog.waitFor()
  await page.getByRole('button', { name: '同意并开启（3秒）', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^同意并开启/ }).isDisabled(), true)
  await page.getByRole('button', { name: '暂不参加', exact: true }).click()
  assert.equal((await page.evaluate(() => window.modmind.contributions.getState())).enabled, false)
  assert.equal(await app.evaluate(() => globalThis.__contributionQa.calls.length), 0)
  await toggle.click(); await dialog.waitFor()
  await page.screenshot({ path: path.join(work, 'terms-desktop.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.setSize(1080, 680)))
  await page.screenshot({ path: path.join(work, 'terms-narrow.png') })
  const bounds = await dialog.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1080 && bounds.y + bounds.height <= 680)
  await page.getByRole('button', { name: '同意并开启', exact: true }).waitFor({ state: 'visible', timeout: 7000 })
  await page.getByRole('button', { name: '同意并开启', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(async () => (await window.modmind.contributions.getState()).enabled)
  await page.evaluate(async directory => { try { await window.modmind.project.openRecent(directory + '/missing-private-fixture') } catch {} }, work)
  const preview = await page.evaluate(() => window.modmind.contributions.preview())
  assert.match(preview.folder, /^guest_[a-f0-9]{10}$/)
  assert.ok(preview.reports.some(r => r.metrics.some(m => m.feature === 'project.open' && m.outcome === 'failed')))
  assert.ok(!JSON.stringify(preview.reports).includes('missing-private-fixture'))
  await page.getByRole('button', { name: '查看待传内容', exact: true }).click()
  await page.getByRole('dialog', { name: '待传贡献内容' }).waitFor()
  await page.screenshot({ path: path.join(work, 'preview-narrow.png') })
  await page.keyboard.press('Escape')
  await app.evaluate(() => { globalThis.__contributionQa.offline = true })
  await app.evaluate(() => globalThis.__contributionQa.module.__contributionQa.flush())
  const waiting = await page.evaluate(() => window.modmind.contributions.getState())
  assert.equal(waiting.phase, 'waiting'); assert.ok(waiting.pendingReports > 0)
  // Advance wall clock only in this isolated process, then run the production retry method.
  await app.evaluate(() => { globalThis.__contributionQa.offline = false; const now = Date.now; Date.now = () => now() + 61000 })
  await app.evaluate(() => globalThis.__contributionQa.module.__contributionQa.flush())
  const sent = await page.evaluate(() => window.modmind.contributions.getState())
  assert.equal(sent.pendingReports, 0); assert.ok(sent.lastUploadedAt)
  assert.equal(await app.evaluate(() => globalThis.__contributionQa.uploads.length), 1)

  const encryptedFixture = await app.evaluate(({ safeStorage }) => safeStorage.encryptString('qa-fixture-not-a-real-key').toString('base64'))
  await writeFile(path.join(profile, 'device-credentials.json'), JSON.stringify({
    version: 1, username: 'ContributionQA', balanceCents: '0', siteUrl: 'https://ether-studio.top', baseUrl: 'https://relay.invalid/v1', encryptedApiKey: encryptedFixture
  }))
  const logged = await page.evaluate(() => window.modmind.contributions.getState())
  assert.match(logged.folder, /^ContributionQA_[a-f0-9]{10}$/)
  await page.evaluate(directory => window.modmind.project.openRecent(directory), project)
  await app.evaluate(() => globalThis.__contributionQa.module.__contributionQa.flush())
  const loggedUpload = await app.evaluate(() => globalThis.__contributionQa.uploads.at(-1))
  assert.ok(loggedUpload.key.startsWith(logged.folder + '/'))
  assert.ok(!JSON.stringify(loggedUpload.report).includes('ContributionQA'))
  await rm(path.join(profile, 'device-credentials.json'))
  assert.equal((await page.evaluate(() => window.modmind.contributions.getState())).folder, sent.folder)

  await page.evaluate(directory => window.modmind.project.openRecent(directory), project)
  let bridge = await page.evaluate(() => window.modmind.mcpBridge.setEnabled(true))
  for (let i = 0; i < 30 && !bridge.mcpConfigPath; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    bridge = await page.evaluate(() => window.modmind.mcpBridge.getState())
  }
  assert.ok(bridge.mcpConfigPath, JSON.stringify(bridge))
  const config = JSON.parse(await readFile(bridge.mcpConfigPath, 'utf8')).mcpServers.modmind
  child = spawn(config.command, config.args, { cwd: root, env: { ...env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  reader = createInterface({ input: child.stdout })
  let sequence = 0
  const pending = new Map()
  reader.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id) })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')) }, 20000)
    pending.set(id, response => { clearTimeout(timer); resolve(response) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contribution-qa', version: '1' } })
  const tools = await rpc('tools/list')
  assert.ok(tools.result.tools.some(tool => tool.name === 'modmind_diagnostics'))
  const result = await rpc('tools/call', { name: 'modmind_diagnostics', arguments: { limit: 1 } })
  assert.ok(!result.result.isError, JSON.stringify(result))
  const diagnostic = JSON.parse(result.result.content[0].text)
  assert.equal(diagnostic.contribution.state.enabled, true)
  assert.equal(diagnostic.contribution.state.folder, sent.folder)
  assert.ok(diagnostic.contribution.controlPolicy.includes('3 秒'))
  const bad = await rpc('tools/call', { name: 'modmind_diagnostics', arguments: { limit: 1, enable: true } })
  assert.equal(bad.result.isError, true)
  child.kill(); child = undefined; reader.close(); reader = undefined
  await page.evaluate(() => window.modmind.mcpBridge.setEnabled(false))
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('[aria-label="自动贡献使用统计"]')?.getAttribute('aria-checked') === 'false')
  await toggle.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))) })
  const disabled = await page.evaluate(() => window.modmind.contributions.getState())
  assert.equal(disabled.enabled, false); assert.equal(disabled.pendingReports, 0)
  const stored = JSON.parse(await readFile(path.join(profile, 'contributions.json'), 'utf8'))
  assert.equal(stored.enabled, false); assert.deepEqual(stored.entries, [])
  await page.screenshot({ path: path.join(work, 'settings-narrow.png') })
  assert.deepEqual(errors, [])
  const report = { work, verified: ['default off/no network', 'main 3 second consent', 'cancel and countdown reset', 'actual enable', 'safe pending preview', 'offline retry', 'upload success', 'logged-in username_hash and stable guest folders', 'MCP discovery and read', 'MCP rejects consent writes', 'disable clears queue', '1280x800 and 1080x680 dark screenshots'] }
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  await page?.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined)
  console.error(JSON.stringify({ work, message: error.message, rendererErrors: errors }))
  process.exitCode = 1
} finally { child?.kill(); reader?.close(); await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app?.close().catch(() => undefined) }
