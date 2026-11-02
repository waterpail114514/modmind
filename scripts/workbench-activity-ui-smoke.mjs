import { chromium } from 'playwright'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results/workbench-activity', String(Date.now()))
await fs.mkdir(output, { recursive: true })
// Mount the shipped process component with replayable host events; no model account is used.
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import AgentActivityList from './src/renderer/src/components/AgentActivityList';
  import { reduceWorkbenchOutput } from './src/renderer/src/workbenchTimeline';
  import { applyAppearance } from './src/renderer/src/theme';
  import './src/renderer/src/theme-tokens.css';
  import './src/renderer/src/styles.css';
  import './src/renderer/src/palette.css';
  import './src/renderer/src/appearance.css';
  import './src/renderer/src/minimal-workbench.css';
  applyAppearance({ themePreset:'modmind', darkMode:false });
  const time = new Date().toISOString();
  const command = (id, cmd) => ({ id, kind:'tool', content:'运行命令', time, status:'done', activity:{ kind:'command', title:'运行命令', command:cmd, status:'completed', startedAt:time, output:'验证完成，退出码 0' } });
  const files = ['main.ts','minecraftRuntime.ts','gradleNetworkPolicy.test.ts','gradleNetworkPolicy.ts','release-notes.json','managedBuildTasks.ts','workbenchTimeline.ts','AgentWorkbench.tsx'].map((name,i)=>({id:'file-'+i, kind:'tool', content:'编辑文件', time, status:'done', activity:{kind:'file',title:'编辑文件',status:'completed',startedAt:time,files:[{path:'src/main/'+name,operation:i===2||i===3?'create':'edit',added:i===1?25:20,removed:i===1?1:0}]}}));
  const initial = [command('cmd1',"Get-Content -LiteralPath 'package.json' -Raw"), command('cmd2',"rg -n 'test_session|test_session|operation|stop|cancel' feature-plugins/testing/src/main/minecraftRuntime.ts"), ...files];
  function Harness(){
    const [items,setItems]=useState(initial);const [dark,setDark]=useState(false);const [instance,setInstance]=useState(0);
    window.__activityQa={ set: value=>setItems(value), remount:value=>{setItems(value);setInstance(current=>current+1)}, update:event=>setItems(current=>reduceWorkbenchOutput(current,event)), theme:value=>{setDark(value);applyAppearance({themePreset:'modmind',darkMode:value});} };
    return <div className={'app-shell'+(dark?' dark-mode':'')}><main className="agent-workbench qa-surface">
      <p className="qa-quiet">运行了命令</p>
      <p className="qa-narration">已找到项目的构建入口。我会保留现有改动，补充最小验证日志，然后执行托管构建，检查生成的 JAR。</p>
      <AgentActivityList key={instance} items={items} onOpenFile={file=>window.__openedFile=file} />
      <p className="qa-narration">项目文件已更新，正在准备验证环境。</p>
    </main></div>;
  }
  createRoot(document.getElementById('root')).render(<Harness/>);
` }, bundle: true, write: false, outdir: output, format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' } })
const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="margin:0"><div id="root"></div></body></html>'
const extraCss = '.app-shell{min-height:100vh;background:var(--theme-surface);color:var(--theme-text)}.qa-surface{display:block;width:min(820px,calc(100% - 96px));margin:0 auto;padding:48px 0;background:transparent}.qa-narration{font-size:14px;line-height:1.9;margin:12px 0 18px}.qa-quiet{font-size:13px;color:var(--theme-muted);margin:0 0 18px}.qa-surface .agent-activity-list{margin-bottom:20px}'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.setContent(html)
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text + extraCss })
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text })
  const heading = page.locator('.agent-activity-heading')
  await page.getByRole('button', { name:'编辑了 8 个文件并运行了 2 条命令', exact:true }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0,0)
  if(await heading.getAttribute('aria-expanded') !== 'false' || await page.locator('.agent-activity-item').count() !== 0) throw Error('Process groups must start collapsed')
  if(await heading.locator('.agent-activity-chevron').evaluate(element=>getComputedStyle(element).opacity) !== '0') throw Error('Collapsed chevron is visible at rest')
  if(!await heading.locator('svg:first-child').getAttribute('class').then(value=>value.includes('lucide-pencil'))) throw Error('Mixed file/command summary needs an edit icon')
  await page.screenshot({ path:path.join(output,'01-light-1440.png') })
  await page.screenshot({ path:path.join(output,'preview.png'), clip:{x:270,y:28,width:900,height:260} })
  const computed = await page.evaluate(() => ({font: getComputedStyle(document.body).fontFamily, text: getComputedStyle(document.querySelector('.agent-activity-list')).color, muted: getComputedStyle(document.documentElement).getPropertyValue('--theme-muted')}))
  const restingBox = await heading.boundingBox()
  await heading.hover()
  if(await heading.locator('.agent-activity-chevron').evaluate(element=>getComputedStyle(element).opacity) !== '1') throw Error('Hover does not reveal chevron')
  const hoveredBox = await heading.boundingBox()
  if(restingBox.width !== hoveredBox.width || restingBox.height !== hoveredBox.height) throw Error('Chevron hover shifts the heading')
  await page.screenshot({path:path.join(output,'01a-hover.png')})
  await heading.click()
  await page.screenshot({path:path.join(output,'01b-expanded.png')})
  await page.getByRole('button', {name:'main.ts',exact:true}).click()
  if (await page.evaluate(()=>window.__openedFile) !== 'src/main/main.ts') throw Error('File navigation failed')
  await page.getByRole('button', {name:/已运行 Get-Content/}).click()
  await page.getByText('验证完成，退出码 0',{exact:true}).waitFor()
  await page.getByRole('button', {name:/已运行 Get-Content/}).click()
  checks.push('commands expand, file links invoke the editor callback, long commands truncate')
  await heading.click()
  await page.mouse.move(0,0)
  await heading.evaluate(element=>element.blur())
  await page.locator('body').evaluate(element=>{element.tabIndex=-1;element.focus()})
  await page.keyboard.press('Tab')
  if(await heading.locator('.agent-activity-chevron').evaluate(element=>getComputedStyle(element).opacity) !== '1') throw Error('Keyboard focus does not reveal chevron')
  await page.keyboard.press('Enter')
  if(await heading.getAttribute('aria-expanded') !== 'true') throw Error('Keyboard expansion failed')
  await page.keyboard.press('Enter')
  checks.push('process groups default to collapsed; hover and keyboard focus reveal the arrow without shifting the layout; summary uses the action icon')
  await page.evaluate(()=>window.__activityQa.set([{id:'probe',kind:'tool',content:'工具连接正常',time:new Date().toISOString(),status:'done'}]))
  const startedAt = new Date().toISOString()
  const send = (sequence, activity) => page.evaluate(({sequence,activity})=>window.__activityQa.update({ kind:'tool',content:activity.title,activity,itemId:'build',streamId:'build',turnId:'qa',runId:'qa',sequence,eventId:'e'+sequence,time:new Date().toISOString() }),{sequence,activity})
  const activity = {kind:'build',title:'构建项目',status:'running',startedAt,detail:'正在准备构建环境'}
  await send(1,activity)
  await send(2,{...activity,detail:'正在编译 5364 个源文件',output:'> Task :createMinecraftArtifacts\nCompiling 5364 source files\n'})
  if(await heading.getAttribute('aria-expanded') !== 'false') throw Error('Progress updates reopened the group')
  await page.getByRole('status').getByText('正在编译 5364 个源文件').waitFor()
  await heading.click()
  await page.getByRole('button',{name:/构建项目 正在编译 5364/}).waitFor()
  if(await page.locator('.agent-activity-item').count()!==2)throw Error('Repeated updates duplicated the row')
  await page.screenshot({path:path.join(output,'02-running-build.png')})
  await send(3,{...activity,status:'failed',completedAt:new Date().toISOString(),detail:'依赖下载超时，可重试',output:'Dependency download timed out'})
  await page.getByRole('button',{name:/构建项目失败 依赖下载超时/}).waitFor()
  await page.getByRole('button',{name:/构建项目失败 依赖下载超时/}).click()
  await page.getByText('Dependency download timed out',{exact:true}).waitFor()
  await page.screenshot({path:path.join(output,'03-failure-expanded.png')})
  checks.push('build updates one row, collapsed running status remains visible, failures retain expandable evidence')
  await page.evaluate(()=>window.__activityQa.theme(true))
  await page.setViewportSize({width:1080,height:680})
  await page.screenshot({path:path.join(output,'04-dark-1080.png')})
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)
  if(overflow)throw Error('Horizontal overflow at minimum desktop size')
  await heading.focus()
  await page.keyboard.press('Enter')
  if(await heading.getAttribute('aria-expanded')!=='false')throw Error('Keyboard collapse failed')
  checks.push('dark theme, 1080×680 minimum window and keyboard disclosure verified')
  await page.evaluate(() => window.__activityQa.set([
    ['tool','命令已完成：rg 构建日志','done'], ['tool','AI 正在运行 Gradle 构建','done'],
    ['tool','AI 已应用代码修改','done'], ['tool','已创建文件 src/new.ts','done'],
    ['tool','搜索项目文件','done'], ['tool','检查操作权限','done'],
    ['tool','读取项目文件','done'], ['thinking','Codex 正在分析项目','done'],
    ['tool','已查看 1 张图像','done'], ['tool','上下文已自动压缩','done'],
    ['tool','正在执行命令：npm test','error'], ['tool','正在执行命令：npm test','running'],
    ['start','托管任务已启动','done']
  ].map(([kind,content,status],i) => ({ id:'legacy-'+i,kind,content,status,time:new Date().toISOString() }))))
  await page.locator('.agent-activity-heading').click()
  const icons = await page.locator('.agent-activity-line > svg:first-child').evaluateAll(elements => elements.map(element => element.getAttribute('class')))
  const expected = ['square-terminal','hammer','pencil','file-plus','search','shield-check','wrench','brain','images','scan-line','circle-alert','loader-circle','clock']
  if(icons.length !== expected.length || icons.some((icon,i) => !icon.includes('lucide-'+expected[i]))) throw Error('Legacy process icons: '+JSON.stringify(icons))
  await page.evaluate(()=>window.__activityQa.theme(false))
  await page.screenshot({path:path.join(output,'05-legacy-icons.png')})
  checks.push('legacy titles keep distinct command, build, edit, create, search, approval, tool and thinking icons; failures and live states still override them')
  // Remount each one-step group so the default state is exercised independently.
  await page.evaluate(() => window.__activityQa.set([]))
  await page.locator('.agent-activity-list').waitFor({state:'detached'})
  await page.evaluate(() => window.__activityQa.remount([{ id:'single-command',kind:'tool',content:'命令已完成：git status --short',status:'done',time:new Date().toISOString() }]))
  await page.getByRole('button',{name:'运行了命令',exact:true}).waitFor()
  if(await heading.getAttribute('aria-expanded') !== 'false' || !await heading.locator('svg:first-child').getAttribute('class').then(value=>value.includes('lucide-square-terminal'))) throw Error('Single command must start collapsed with a terminal icon')
  await page.mouse.move(0,0)
  await heading.evaluate(element=>element.blur())
  if(await heading.locator('.agent-activity-chevron').evaluate(element=>getComputedStyle(element).opacity) !== '0') throw Error('Single command chevron is visible at rest')
  await heading.click()
  await page.getByRole('button',{name:'命令已完成：git status --short',exact:true}).waitFor()
  checks.push('single legacy commands also start collapsed and keep a terminal summary icon')
  // A local, interactive artifact built from the same shipped component.
  const css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text+extraCss
  const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text
  await fs.writeFile(path.join(output,'preview.html'),html.replace('</body>',`<style>${css}</style><script>${js.replaceAll('</script','<\\/script')}</script></body>`))
  if(errors.length)throw Error(errors.join('\n'))
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,computed},null,2))
  console.log(JSON.stringify({output,checks,errors,computed},null,2))
} catch(error) { await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error }
finally { await browser.close() }
