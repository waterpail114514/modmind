import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(path.join(path.dirname(process.env.APPDATA), 'modmind-hot-switch-'));
const userData = path.join(root, 'data');
const project = path.join(root, 'testmod');
await fs.mkdir(userData);
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'modmind.project.json'), JSON.stringify({ name: 'testmod', path: project, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'testmod', createdAt: new Date().toISOString() }));
await fs.cp(path.join(process.env.APPDATA, 'modmind', 'codex-runtime', '0.146.0-win32-x64'), path.join(userData, 'codex-runtime', '0.146.0-win32-x64'), { recursive: true });
const requests = [];
let application;
let page;
let base;
let current = 'A';
const models = { A: 'gpt-5.6-terra', B: 'gpt-5.6-sol', free: 'qwen3.8-flash' };
let releaseUsage;
let holdUsage = false;
let heldUsage = false;
let usageFailure = true;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  const body = text ? JSON.parse(text) : {};
  const url = request.url;
  const json = (data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  const row = { time: new Date().toISOString(), url, model: body.model, credential: request.headers.authorization, input: body.input };
  requests.push(row);
  if (url === '/api/device/poll') return json({ success: true, data: { status: 'ok', baseUrl: `${base}/${current}/v1`, apiKey: `test-${current}`, balanceCents: '10000', username: 'test-account' } });
  if (url === '/api/device/usage') {
    if (holdUsage) {
      heldUsage = true;
      await new Promise(resolve => { releaseUsage = resolve; });
      if (usageFailure) return json({ error: 'Old key invalid' }, 401);
    }
    return json({ success: true, data: { keyStatus: 'ACTIVE', frozenReason: null, balanceCents: '10000', usedQuota: '0', remainQuota: '10000', billedCentsTotal: '0', lastSeenUsedQuota: '0', quotaSyncedAt: new Date().toISOString(), checkedAt: new Date().toISOString() } });
  }
  const match = /^\/(A|B|free)\/v1\/(models|responses)$/.exec(url);
  if (!match) return json({ error: 'Not found' }, 404);
  const route = match[1];
  if (match[2] === 'models') return json({ data: [{ id: models[route] }] });
  if (route !== 'free') { response.once('close', () => { row.closed = true; }); return; }
  if (body.model !== models.free) return json({ error: { message: 'Wrong model' } }, 400);
  if ((body.input || []).some(item => item.type === 'message' && item.id && !item.id.startsWith('msg_'))) return json({ error: { message: 'Invalid message id' } }, 400);
  const item = { type: 'message', id: 'msg_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'HS-47: testmod read-only check completed.', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_final', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_final', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (predicate, label, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
async function sync(route) {
  current = route;
  await application.evaluate(({ app }, link) => app.emit('open-url', { preventDefault() {} }, link), `mcdev://sync?site=${encodeURIComponent(base)}&code=TESTAA`);
  await waitFor(async () => {
    const preferences = await page.evaluate(() => window.modmind.device.getAiPreferences());
    const state = await page.evaluate(() => window.modmind.device.getState());
    return preferences.model === models[route] && state.status === 'connected';
  }, `sync ${route}`);
}
try {
  const launchEnv = { ...process.env, MODMIND_TEST_USER_DATA: userData, MODMIND_SITE_URL: base };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [path.resolve('test-results/hot-switch-app-bootstrap.cjs')], env: launchEnv, timeout: 30000 });
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), userData);
  await application.firstWindow();
  await waitFor(async () => {
    for (const candidate of application.windows()) {
      if (await candidate.evaluate(() => Boolean(window.modmind)).catch(() => false)) { page = candidate; return true; }
    }
    return false;
  }, 'application preload');
  await page.evaluate(() => { window.hotSwitchEvents = []; window.modmind.ai.onOutput(event => window.hotSwitchEvents.push(event)); });
  await page.evaluate(projectPath => window.modmind.project.openRecent(projectPath), project);
  await sync('A');
  await page.evaluate(projectPath => {
    window.hotSwitchTask = { state: 'running' };
    void window.modmind.ai.createCode('Only answer a read-only question. Remember HS-47. Do not edit files or call tools.', undefined, 'quota', 'standard', { projectPath, sessionScope: 'workspace/e2e' })
      .then(result => { window.hotSwitchTask = { state: 'completed', result }; }, error => { window.hotSwitchTask = { state: 'failed', error: String(error) }; });
  }, project);
  await waitFor(() => requests.some(row => row.url === '/A/v1/responses'), 'A model request');
  await sync('B');
  await waitFor(() => requests.some(row => row.url === '/B/v1/responses'), 'automatic B continuation');
  await sync('free');
  await waitFor(async () => (await page.evaluate(() => window.hotSwitchTask)).state !== 'running', 'task completion');
  const task = await page.evaluate(() => window.hotSwitchTask);
  assert.equal(task.state, 'completed', JSON.stringify(task));
  const modelRequests = requests.filter(row => row.url.endsWith('/responses'));
  assert.deepEqual(modelRequests.map(row => row.model), Object.values(models));
  assert.deepEqual(modelRequests.map(row => row.credential), ['Bearer test-A', 'Bearer test-B', 'Bearer test-free']);
  assert.ok(modelRequests[0].closed && modelRequests[1].closed);
  // Both successful and rejected old usage responses must leave the new credential intact.
  for (const failure of [true, false]) {
    await sync('A');
    usageFailure = failure;
    heldUsage = false;
    holdUsage = true;
    await page.evaluate(() => { window.usageDone = false; void window.modmind.device.refreshUsage().finally(() => { window.usageDone = true; }); });
    await waitFor(() => heldUsage, 'old usage request');
    await sync('B');
    holdUsage = false;
    releaseUsage();
    await waitFor(() => page.evaluate(() => window.usageDone), 'usage completion');
    assert.equal((await page.evaluate(() => window.modmind.device.getState())).status, 'connected');
    const disk = JSON.parse(await fs.readFile(path.join(userData, 'device-credentials.json'), 'utf8'));
    assert.equal(disk.baseUrl, `${base}/B/v1`);
  }
  const report = { passed: true, isolatedUserData: userData, modelRequests, task, late401PreservedNewCredentials: true, lateSuccessPreservedNewCredentials: true, events: await page.evaluate(() => window.hotSwitchEvents) };
  await fs.writeFile('test-results/hot-switch-app-e2e-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, requests: modelRequests.map(({ url, model }) => ({ url, model })), late401PreservedNewCredentials: true, lateSuccessPreservedNewCredentials: true }));
} catch (error) {
  console.error(error);
  if (page) console.error(JSON.stringify(await page.evaluate(() => ({ task: window.hotSwitchTask, events: window.hotSwitchEvents?.slice(-8) })).catch(() => ({}))));
  console.error('Isolated fixture:', root);
  process.exitCode = 1;
} finally {
  releaseUsage?.();
  if (application) {
    let timer;
    try {
      await Promise.race([application.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test application cleanup timed out')), 8000); })]);
    } catch {
      application.process().kill();
    } finally { clearTimeout(timer); }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Preserve the isolated fixture and diagnostics for inspection; it contains only fake keys.
}
// Playwright can retain its inspector transport after an already exited Electron process.
process.exit(process.exitCode || 0);
