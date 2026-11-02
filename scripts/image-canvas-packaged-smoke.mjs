import {_electron as electron} from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {checkCanvasInteractions} from './fixtures/image-canvas-interaction-checks.mjs'
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'test-results/image-canvas')
await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-image-canvas-electron-'))
const html=path.join(output,'packaged.html'),bootstrap=path.join(output,'electron.cjs')
await fs.writeFile(html,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="../../feature-plugin-dist/image-studio/renderer.css"><body style="margin:0"><div id="workspace"></div><script src="fixture.js"></script></body></html>')
await fs.writeFile(bootstrap,`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:1080,height:680,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(html)});});app.on('window-all-closed',()=>app.quit());`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({args:[bootstrap],cwd:root,env,timeout:30000})
try{
 const page=await app.firstWindow(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.getByTestId('open-canvas-workspace').waitFor()
 await checkCanvasInteractions(page,output,'electron-1080')
 const graph={title:'离线桌面画布',graph:{version:1,viewport:{x:0,y:0,zoom:1},nodes:[{id:'packaged-test',type:'image',position:{x:80,y:80},width:400,data:{title:'桌面生成',model:'image-fixture',prompt:'离线桌面模拟生成',count:2,aspectRatio:'1:1',resolution:'1K'}}],edges:[]}}
 await page.getByTestId('open-canvas-import').setInputFiles({name:'packaged-canvas.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(graph))})
 await page.locator('.react-flow__node').first().waitFor()
 await page.locator('.react-flow__node').first().click()
 await page.getByRole('button',{name:'生成',exact:true}).click()
 await page.getByRole('button',{name:'送去处理',exact:true}).first().waitFor()
 const request=await page.evaluate(()=>window.canvasQa.requests[0])
 if(request.count!==2||new URL(page.url()).protocol!=='file:'||errors.length)throw new Error(JSON.stringify({request,errors,url:page.url()}))
 await page.getByRole('button',{name:'送去处理',exact:true}).first().click()
 await page.getByRole('button',{name:'PerfectPixel',exact:true}).click()
 await page.getByRole('tab',{name:'生成',exact:true}).click()
 await page.reload()
 await page.locator('.react-flow__node').first().waitFor()
 await fs.writeFile(path.join(output,'packaged-verification.json'),JSON.stringify({success:true,origin:'file://',externalNetwork:'blocked',errors,checks:['left-button-pan','right-button-box-selection','right-click-menu','left-button-node-drag','selection-blur-recovery','double-click-node-menu','create-image-node','wheel-zoom-in-out','pointer-centered-zoom','prompt-editing-boundaries','packaged-renderer','local-runtime-routes','batch-2','process-handoff','offline-reload'],fixtureOnly:true},null,2))
 console.log('PASS Electron file:// canvas, batch and offline reload.')
}finally{await app.close()}
