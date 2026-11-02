import { build } from 'esbuild'
import { chromium } from 'playwright'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

// Component integration test only: no preview page or development server is created.
// The shipped app mounts this exact component through OnboardingGuide.
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results/moko-onboarding', String(Date.now()))
await fs.mkdir(output, { recursive: true })
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import MokoOnboarding from './src/renderer/src/components/MokoOnboarding';
  import { freshOnboarding, resumeOnboarding } from './src/renderer/src/onboarding';
  import { applyAppearance } from './src/renderer/src/theme';
  import './src/renderer/src/theme-tokens.css';
  import './src/renderer/src/styles.css';
  import './src/renderer/src/workspace-chrome.css';
  import './src/renderer/src/palette.css';
  import './src/renderer/src/appearance.css';
  applyAppearance({ themePreset:'modmind', darkMode:false });
  function Harness() {
    const [session, setSession] = useState(freshOnboarding);
    const [account, setAccount] = useState({ status:'disconnected', configured:true });
    const [accountOpen, setAccountOpen] = useState(false);
    window.__mokoQa = {
      session, accountOpen,
      restart: () => { setSession(freshOnboarding()); setAccountOpen(false); },
      resume: () => setSession(current => resumeOnboarding(current)),
      account: (value) => setAccount(value),
      returnFromLogin: (value) => { setAccount(value); setAccountOpen(false); },
      theme: (darkMode) => applyAppearance({ themePreset:'modmind', darkMode }),
      complete: () => setSession({ ...freshOnboarding(), phase:'complete', goal:'mod', task:'item', projectPath:'test-project' })
    };
    return <><header className="titlebar"><div className="titlebar-name">ModMind</div><div className="titlebar-actions"><button className="window-control" onClick={() => window.__windowControlClicks++}>窗口操作</button></div></header><div className="app-body"><button>背景中的操作</button></div>
      {session.status === 'running' && ['experience','goal','task','complete'].includes(session.phase) && !accountOpen ? <MokoOnboarding session={session} update={patch => setSession(current => ({ ...current, ...patch }))} account={account} onOpenAccount={() => setAccountOpen(true)} onPause={() => setSession(current => ({ ...current, status:'paused' }))} projectName="我的第一个项目" /> : null}
    </>;
  }
  window.__windowControlClicks = 0;
  createRoot(document.getElementById('root')).render(<React.StrictMode><Harness /></React.StrictMode>);
` }, bundle: true, write: false, outdir: output, format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' } })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
const errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>')
await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text })
await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text })
const scene = () => page.locator('.moko-onboarding')
const step = value => page.locator(`.moko-onboarding[data-moko-step="${value}"]`)
const phase = value => page.locator(`.moko-onboarding[data-moko-phase="${value}"]`)
const stageClick = () => page.mouse.click(page.viewportSize().width - 35, 210)
const finishText = async () => {
  if (await scene().getAttribute('data-moko-pure') === 'true') {
    if (await page.locator('.moko-continue-hint').innerText() === '点击任意位置显示全文') await stageClick()
  } else {
    const reveal = page.getByRole('button', { name: '显示全文', exact: true })
    if (await reveal.isVisible()) await reveal.click()
  }
}
async function next() { await finishText(); await stageClick() }
async function start(experience = '是呀，第一次来') {
  await step('hello').waitFor()
  await next()
  await page.getByRole('button', { name: experience, exact: true }).click()
  await next()
  await step('account').waitFor()
  await finishText()
}
async function capture(name, width = 1280, height = 820) {
  assert.ok(width >= 1080 && height >= 680)
  await page.setViewportSize({ width, height })
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))) })
  const bounds = await page.evaluate(() => {
    const actor = document.querySelector('.moko-actor').getBoundingClientRect()
    const box = document.querySelector('.moko-dialogue').getBoundingClientRect()
    const stage = document.querySelector('.moko-stage').getBoundingClientRect()
    const dialog = document.querySelector('.moko-onboarding')
    const controlsFit = Array.from(dialog.querySelectorAll('button')).filter(button => button.getClientRects().length && !button.closest('[inert]')).every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 42 && rect.bottom <= innerHeight })
    return { actorBottom:actor.bottom, actorHeight:actor.height, dialogueTop:box.top, stageHeight:stage.height, clip:getComputedStyle(dialog).overflowY, controlsFit }
  })
  assert.ok(bounds.actorBottom > bounds.dialogueTop + 100, 'Lower body remains behind the opaque dialogue box')
  assert.ok(bounds.actorHeight >= bounds.stageHeight * 1.7, 'Portrait is enlarged to a half-body composition')
  assert.equal(bounds.clip, 'clip', `${name}: oversized portrait is clipped without a scroll container`)
  assert.ok(bounds.controlsFit, `${name}: all controls remain in the window`)
  await page.screenshot({ path: path.join(output, `${name}.png`) })
  if (name === '01-opening') await scene().screenshot({ path: path.join(output, '01-opening-surface.png') })
}

try {
  await step('hello').waitFor()
  await finishText()
  assert.equal(await page.locator('.app-body').evaluate(element => element.inert), true)
  assert.equal(await page.getByRole('button', { name: '继续', exact: true }).count(), 0)
  await capture('01-opening')
  await page.getByRole('button', { name: '窗口操作', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__windowControlClicks), 1)
  assert.equal(await scene().getAttribute('data-moko-step'), 'hello', 'Window controls do not advance dialogue')
  await next()
  await page.getByRole('button', { name: '是呀，第一次来', exact: true }).click()
  await finishText()
  assert.equal(await scene().getAttribute('data-moko-step'), 'new', 'Selecting an answer does not also advance the next line')
  await next()
  await step('account').waitFor()
  await finishText()
  await stageClick()
  assert.equal(await scene().getAttribute('data-moko-step'), 'account', 'Empty-space clicks cannot bypass login choices')
  await capture('02-account')
  await page.getByRole('button', { name: '登录账号', exact: true }).click()
  assert.equal(await scene().count(), 0)
  assert.equal(await page.locator('.app-body').evaluate(element => element.inert), false)
  await page.evaluate(() => window.__mokoQa.returnFromLogin({ status:'error', configured:true }))
  await step('account').waitFor()
  await finishText()
  assert.match(await page.getByRole('status').innerText(), /账号暂时没连上/)
  await page.getByRole('button', { name: '重新登录', exact: true }).click()
  await page.evaluate(() => window.__mokoQa.returnFromLogin({ status:'connected', configured:true, username:'旅行者' }))
  await step('account').waitFor()
  await finishText()
  assert.match(await page.getByRole('status').innerText(), /啊，旅行者！/)
  await next()
  await next()
  await phase('goal').waitFor()
  await page.getByRole('button', { name: '制作模组', exact: false }).click()
  await page.getByRole('button', { name: '制作光影', exact: false }).click()
  await page.getByRole('button', { name: '制作模组', exact: false }).click()
  await finishText()
  await page.waitForTimeout(180)
  assert.equal(await page.getByRole('button', { name: '显示全文', exact: true }).count(), 0)
  await stageClick()
  assert.equal(await scene().getAttribute('data-moko-phase'), 'goal', 'Choice rounds need explicit confirmation')
  await capture('03-goal-light')
  await capture('04-goal-light-minimum', 1080, 680)
  await page.evaluate(() => window.__mokoQa.theme(true))
  await capture('05-goal-dark-minimum', 1080, 680)
  await page.getByRole('button', { name: '就选这个', exact: true }).click()
  await page.getByRole('button', { name: '准备制作第一个物品', exact: true }).click()
  await finishText()
  await page.getByRole('button', { name: '准备工具', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__mokoQa.session.phase), 'features')
  checks.push('portrait behind dialogue; surface clicks; controls do not double-advance; login callback with simulated account states; first task hands off to existing guide')
  await page.evaluate(() => { window.__mokoQa.restart(); window.__mokoQa.account({ status:'disconnected', configured:true }) })
  await start('以前用过啦')
  await page.getByRole('button', { name: '稍后登录', exact: true }).click()
  await next()
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => window.__mokoQa.session.status), 'paused')
  assert.equal(await page.locator('.app-body').evaluate(element => element.inert), false)
  await page.evaluate(() => window.__mokoQa.resume())
  await phase('goal').waitFor()
  checks.push('returning-user route, skip login, pause/resume, fresh local-only bundled assets')
  await page.evaluate(() => window.__mokoQa.restart())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await step('hello').waitFor()
  assert.equal(await page.locator('.moko-continue-hint').innerText(), '点击任意位置继续')
  assert.equal(await page.locator('.moko-actor').evaluate(element => element.getAnimations().flatMap(animation => animation.effect.getKeyframes()).some(frame => frame.transform)), false)
  await page.keyboard.press('Space')
  await step('experience').waitFor()
  await page.keyboard.press('Tab')
  assert.ok(await scene().evaluate(element => element.contains(document.activeElement)))
  checks.push('React StrictMode, background inert cleanup, keyboard and reduced motion; light/dark at 1280×820 and desktop minimum 1080×680')
  assert.deepEqual(errors, [])
  const result = { surface:'Chromium component integration (no preview page); Electron runtime cannot start on this host', checks, errors, output }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await page.screenshot({ path:path.join(output, 'failure.png') })
  console.error({ errors, output })
  throw error
} finally { await browser.close() }
