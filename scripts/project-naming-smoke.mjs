import { _electron as electron } from 'playwright'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'test-results/project-naming', String(Date.now()))
const profile = path.join(work, 'profile')
const documents = path.join(work, 'documents')
const parent = path.join(work, 'projects')
for (const folder of [profile, documents, parent]) await mkdir(folder, { recursive: true })
await writeFile(path.join(profile, 'recent-projects.json'), '[]')
const bootstrap = path.join(work, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app,dialog,shell}=require('electron');
app.setName('modmind-naming-smoke');app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(${JSON.stringify(root)});app.setPath('documents',${JSON.stringify(documents)});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(parent)}]});
shell.trashItem=async target=>require('node:fs/promises').rename(target,target+'.trashed');
globalThis.namingRequests=[];globalThis.namespaceReply='{"namespace":"lightning_sword"}';
globalThis.fetch=async(url,options)=>{
 if(String(url)==='https://naming.invalid/v1/chat/completions'){
  const body=JSON.parse(options.body);globalThis.namingRequests.push(body);
  if(globalThis.namespaceReply==='offline')throw Error('Fixture offline');
  return new Response(JSON.stringify({choices:[{message:{content:body.messages[0].content.includes('Minecraft namespace')?globalThis.namespaceReply:'闪电剑制作'}}]}));
 }
 throw Error('Offline test request');
};require(${JSON.stringify(path.join(root,'out/main/index.js'))});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], cwd: root, env })
const report = { work, checks: [] }
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.modmind))
  await page.evaluate(async () => {
    const settings = await window.modmind.settings.getAgent()
    await window.modmind.settings.saveAgent({ ...settings, codingBackend: 'codex', externalAgents: { codex: { mode: 'hosted', baseUrl: 'https://naming.invalid/v1', apiKey: 'fixture-only', model: 'fixture-model' } } })
  })
  const create = name => page.evaluate(name => window.modmind.project.create({ name, kind: 'mod', loader: 'bedrock', minecraftVersion: '1.21.100' }), name)
  const original = await create('闪电剑')
  assert.equal(original.namespace, 'lightning_sword')
  assert.equal(original.namespaceSource, 'ai')
  assert.ok(path.basename(original.path).startsWith('mod_'))
  assert.equal(JSON.parse(await readFile(path.join(original.path, 'package.json'), 'utf8')).name, 'lightning_sword')
  report.checks.push('Chinese project name translated before generating template; path retained')

  const title = await page.evaluate(async projectPath => {
    const conversation = await window.modmind.conversations.create(projectPath, { surface: 'workspace', title: 'New' })
    return window.modmind.conversations.generateTitle(projectPath, conversation.id, '制作闪电剑', '可以制作', 'codex')
  }, original.path)
  assert.equal(title.title, '闪电剑制作')
  report.checks.push('Existing conversation naming still uses the shared request')

  const draft = await page.evaluate(() => window.modmind.project.createDraft('基岩 1.21.100 模组 魔法森林'))
  await app.evaluate(() => { globalThis.namespaceReply = '{"namespace":"magic_forest"}' })
  const ready = await page.evaluate(p => window.modmind.project.initializeDraft(p, 'codex', { model: 'selected-fixture-model' }), draft.path)
  assert.equal(ready.namespace, 'magic_forest')
  assert.equal(ready.path, draft.path)
  const requests = await app.evaluate(() => globalThis.namingRequests)
  assert.equal(requests.at(-1).model, 'selected-fixture-model')
  report.checks.push('Draft initialization names namespace and honors selected model')

  const manual = await page.evaluate(() => window.modmind.project.createDraft('基岩 1.21.100 模组'))
  await page.evaluate(p => window.modmind.project.rename({ projectPath: p.path, name: p.name, namespace: p.namespace }), manual)
  const count = await app.evaluate(() => globalThis.namingRequests.length)
  const manualReady = await page.evaluate(p => window.modmind.project.initializeDraft(p, 'codex'), manual.path)
  assert.equal(manualReady.namespace, manual.namespace)
  assert.equal(await app.evaluate(() => globalThis.namingRequests.length), count)
  report.checks.push('Explicitly confirmed manual namespace is never replaced')

  await app.evaluate(() => { globalThis.namespaceReply = 'offline' })
  const offline = await create('离线作品')
  assert.ok(offline.namespace.startsWith('mod_'))
  await app.evaluate(() => { globalThis.namespaceReply = '{"namespace":"../unsafe"}' })
  const invalid = await create('非法结果')
  assert.ok(invalid.namespace.startsWith('mod_'))
  report.checks.push('Offline and invalid AI output both preserve working default namespaces')

  const saveNote = (p, content) => page.evaluate(({ p, content }) => window.modmind.inspiration.updateKnowledge(p, { title: 'Note', content }), { p, content })
  const notes = p => page.evaluate(p => window.modmind.inspiration.readKnowledge(p), p)
  await saveNote(ready.path, 'Keep other project')
  for (const permanent of [false, true]) {
    const project = permanent ? offline : original
    await saveNote(project.path, 'Old project knowledge')
    await page.evaluate(({ projectPath, permanent }) => permanent ? window.modmind.project.deleteProjectPermanent(projectPath) : window.modmind.project.deleteProject(projectPath), { projectPath: project.path, permanent })
    const recreated = await create(project.name)
    assert.equal(recreated.path, project.path)
    assert.deepEqual(await notes(recreated.path), [])
    assert.equal((await notes(ready.path))[0].content, 'Keep other project')
  }
  report.checks.push('Trash and permanent deletion followed by same-path recreation do not inherit knowledge; other project retained')
  report.requests = await app.evaluate(() => globalThis.namingRequests.map(request => ({ model: request.model, prompt: request.messages[0].content })))
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ work, checks: report.checks }, null, 2))
} finally { await app.close() }
