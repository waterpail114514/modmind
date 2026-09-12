import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const source=readFileSync('src/renderer/src/App.tsx','utf8');
const end=source.indexOf('\nfunction RenameProjectDialog');
const start=source.lastIndexOf('\nfunction ',end-1);
const component=source.slice(start,end);
const name=component.match(/function (\w+)/)[1];
writeFileSync('test-results/project-library-preview.tsx',`import React, {useState,useEffect} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {Plus,FolderOpen,PackageOpen,Binary,ChevronRight,Box,X,Pencil,Search} from 'lucide-react';\nimport {platformLabel} from '../src/shared/projectPlatform';\nimport '../src/renderer/src/styles.css';\n${component}\nconst noop=()=>{}; const projects=[{name:'林间物语',path:'D:/Minecraft/forest-world',loader:'fabric',minecraftVersion:'1.21.1'},{name:'机械工坊',path:'D:/Minecraft/create-workshop',loader:'forge',minecraftVersion:'1.20.1'}];\ncreateRoot(document.getElementById('root')!).render(<div className='app-shell' style={{display:'flex',height:'100dvh'}}><${name} projects={projects} onCreate={noop} onOpen={noop} onAdopt={noop} onImportModJar={noop} onSelect={p=>window.selected=p.name} onRemove={noop} onRename={noop}/></div>);`);
writeFileSync('test-results/project-library-preview.html','<div id="root"></div><script type="module" src="./project-library-preview.tsx"></script>');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:5213}});await server.listen();
const browser=await chromium.launch({headless:true});
try {const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.resolvedUrls.local[0]+'test-results/project-library-preview.html');await page.locator('.recent-project-row').first().waitFor();await page.screenshot({path:'test-results/project-library-light.png'});await page.getByLabel('搜索最近项目').fill('1.21');assert.equal(await page.locator('.recent-project-row').count(),1);await page.locator('.recent-project-main').click();assert.equal(await page.evaluate(()=>window.selected),'林间物语');await page.getByLabel('搜索最近项目').fill('missing');assert.equal(await page.locator('.recent-project-empty').isVisible(),true);await page.getByLabel('清除项目搜索').click();assert.equal(await page.locator('.recent-project-row').count(),2);await page.setViewportSize({width:390,height:844});await page.locator('.app-shell').evaluate(el=>el.classList.add('dark-mode'));await page.screenshot({path:'test-results/project-library-narrow.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);console.log('Passed search, no-results, clear, open callback, dark narrow layout; no runtime errors.');}finally{await browser.close();await server.close();}
