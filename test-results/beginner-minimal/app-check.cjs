const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-minimal-app-'));
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-minimal-project-'));
  const project = { name: '闪电剑', path: projectPath, kind: 'mod', loader: 'forge', minecraftVersion: '1.20.1', namespace: 'lightning', projectVersion: '1.0.0', createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(projectPath, 'modmind.project.json'), JSON.stringify(project));
  const env = { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ ipcMain }) => {
      globalThis.minimalCalls = [];
      globalThis.minimalPreferences = { model: 'gpt-5.6-sol', reasoningLevel: 'medium', fastMode: false };
      const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler); };
      replace('device:getState', () => ({ status: 'connected', configured: true, keyStatus: 'ACTIVE', balanceCents: 1200 }));
      replace('device:getAiPreferences', () => globalThis.minimalPreferences);
      replace('device:listModels', () => [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }]);
      replace('device:saveAiPreferences', (_e, value) => { globalThis.minimalPreferences = value; return value; });
      replace('beginner-codex:prepare', () => ({ status: 'ready' }));
      replace('ai:createCode', async (event, prompt, sessionId, backend, executionProfile, options) => {
        globalThis.minimalCalls.push({ prompt, sessionId, backend, executionProfile, options });
        await new Promise(resolve => setTimeout(resolve, 900));
        const discussion = options.workbenchPhase === 'discussion';
        const answer = discussion ? '可以先做一把蓝色闪电剑，右键释放闪电。\n<modmind-choices>[{"label":"讨论配方","prompt":"继续讨论配方","action":"discussion"},{"label":"降低伤害","prompt":"把伤害方案调低","action":"discussion"},{"label":"按这个方案制作","prompt":"确认制作蓝色闪电剑","action":"engineering"}]</modmind-choices>' : '已完成工程阶段的测试替身。';
        event.sender.send('ai:output', { kind: 'answer', content: answer, time: new Date().toISOString(), sessionId, projectPath: options.projectPath, conversationId: options.conversationId, generation: options.generation, turnId: options.turnId, backend });
        return { summary: answer, finalResponse: answer, tasks: [], files: [], changedFiles: [], tests: [], warnings: [], intent: discussion ? 'informational' : 'engineering' };
      });
    });
    await page.evaluate(() => localStorage.setItem('modmind-ui-mode', 'beginner'));
    await page.reload();
    await page.locator('.minimal-project-start').waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('.chat-welcome-options button').count(), 3);
    await page.screenshot({ path: 'test-results/beginner-minimal/app-start.png' });
    for (const dark of [false, true]) {
      await page.locator('.app-shell').evaluate((element, dark) => element.classList.toggle('dark-mode', dark), dark);
      const colors = await page.evaluate(() => [getComputedStyle(document.querySelector('.titlebar')).backgroundColor, getComputedStyle(document.querySelector('.agent-workbench')).backgroundColor]);
      assert.equal(colors[0], colors[1], 'Titlebar and workbench backgrounds should match');
      await page.screenshot({ path: `test-results/beginner-minimal/app-unified-${dark ? 'dark' : 'light'}.png` });
    }
    await page.locator('.app-shell').evaluate(element => element.classList.remove('dark-mode'));
    await page.locator('.minimal-project-trigger').click();
    await app.evaluate(({ ipcMain }, project) => {
      ipcMain.removeHandler('project:listRecent');
      ipcMain.handle('project:listRecent', () => [project]);
    }, project);
    await page.locator('.minimal-project-trigger').click();
    await page.locator('.minimal-project-trigger').click();
    await page.locator('.minimal-project-dropdown').getByRole('button', { name: '闪电剑', exact: true }).click();
    await page.locator('.agent-minimal:not(.minimal-project-start)').waitFor();
    assert.equal(await page.locator('.agent-workbench-header').isVisible(), false);
    await page.locator('.agent-persistence-status.saved,.agent-persistence-status.ready,.agent-persistence-status.degraded').waitFor({ state: 'attached' });
    await page.locator('.agent-composer textarea').fill('做一把右键释放闪电的剑');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.expert-mode-toggle').click();
    await page.locator('.expert-mode-toggle').click();
    await page.getByRole('button', { name: '按这个方案制作', exact: true }).waitFor().catch(async error => { await page.screenshot({ path: 'test-results/beginner-minimal/choice-error.png' }); console.log(await page.locator('.agent-workbench').innerText()); console.log(await app.evaluate(() => globalThis.minimalCalls)); throw error; });
    assert.equal(await page.getByRole('button', { name: '开始制作', exact: true }).count(), 0);
    assert.equal(await page.locator('.discussion-choice-cards button').count(), 3);
    const discussionCalls = await app.evaluate(() => globalThis.minimalCalls);
    assert.equal(discussionCalls.length, 1);
    assert.equal(discussionCalls[0].backend, 'quota');
    assert.equal(discussionCalls[0].options.surface, 'workspace');
    assert.equal(discussionCalls[0].options.workbenchPhase, 'discussion');
    assert.match(discussionCalls[0].prompt, /Minecraft 1.20.1/);
    const ideaExists = await fs.stat(path.join(projectPath, 'docs', 'idea.md')).then(() => true, () => false);
    assert.equal(ideaExists, false, 'Discussion must not call project.captureIdea');
    await page.screenshot({ path: 'test-results/beginner-minimal/app-discussion.png' });
    await page.getByRole('button', { name: '按这个方案制作', exact: true }).click();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
    await page.locator('.agent-send-button:not(.stop)').waitFor();
    const calls = await app.evaluate(() => globalThis.minimalCalls);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].backend, 'quota');
    assert.equal(calls[1].executionProfile, 'beginner-unlimited');
    assert.equal(calls[1].options.workbenchPhase, undefined);
    assert.equal(calls[1].options.conversationId, calls[0].options.conversationId);
    assert.equal(calls[1].options.sessionScope, calls[0].options.sessionScope);
    assert.match(calls[1].prompt, /蓝色闪电剑/);
    assert.match(calls[1].prompt, /确认制作蓝色闪电剑/);
    assert.match(await fs.readFile(path.join(projectPath, 'docs', 'idea.md'), 'utf8'), /蓝色闪电剑/);
    await page.reload();
    await page.locator('.agent-minimal').waitFor();
    await page.getByText('已完成工程阶段的测试替身。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('App integration passed: minimal start, recommendations, shared conversation, discussion before engineering, hot mode switch, no preflight idea write, engineering handoff and history reload. AI mocked; no paid request.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
