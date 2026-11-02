import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as dialogs from '../../src/renderer/src/components/InteractionDialogs'
import MiniPaintEditor from '../../src/renderer/src/components/MiniPaintEditor'
import {themeCssVariables} from '../../src/shared/appTheme'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/palette.css'
import type {ImageGenerationRequest} from '../../src/shared/imageStudio'

const host=window as any
host.__modmindFeatureHost={React,ReactDOM,jsxRuntime,dialogs,MiniPaintEditor}
host.canvasQa={requests:[],saved:[],processed:[],settingsOpened:0}
const image=(index:number)=>{const canvas=document.createElement('canvas');canvas.width=768;canvas.height=512;const ctx=canvas.getContext('2d')!;ctx.fillStyle=['#cee3dd','#e7ddc6','#ced9e9'][index%3];ctx.fillRect(0,0,768,512);ctx.fillStyle='#315b50';ctx.fillRect(220+index*20,140,280,220);ctx.fillStyle='#ffffff';ctx.font='32px sans-serif';ctx.fillText('Canvas '+(index+1),280,260);return canvas.toDataURL('image/png')}
host.modmind={
  imageStudio:{
    getSettings:async()=>({baseUrl:'https://fixture.invalid/v1',model:'image-fixture',hasStoredKey:true,allowAgentImages:true,autoApproveAgentImages:true,manualHostedConsent:true}),
    capabilities:async()=>{if(new URL(location.href).searchParams.has('offline'))throw new Error('当前离线，暂时无法查询图片模型');return {models:['image-fixture'],sizes:['1024x1024','1536x1024','auto'],qualities:['low','medium','high','auto'],moderations:['auto','low'],supportsImageInput:true,supportsMask:false}},
    generate:async(request:ImageGenerationRequest)=>{host.canvasQa.requests.push(structuredClone(request));await new Promise(resolve=>setTimeout(resolve,400));const partial=request.prompt.includes('失败');return {jobId:crypto.randomUUID(),hosted:false,credits:0,assets:Array.from({length:partial?1:request.count},(_,index)=>({id:crypto.randomUUID(),dataUrl:image(index),createdAt:new Date().toISOString(),model:request.model,style:request.style,size:request.size,quality:request.quality,hosted:false,credits:0})),...(partial?{error:'第 2 张生成失败，已保留第 1 张'}:{})}},
    process:async(operation:string,dataUrl:string)=>{host.canvasQa.processed.push(operation);return {dataUrl,operation,detail:'处理完成'}},
    saveAsset:async(dataUrl:string,name:string)=>{host.canvasQa.saved.push({kind:'file',dataUrl,name});return 'test-output.png'},
    saveToProject:async(dataUrl:string,name:string)=>{host.canvasQa.saved.push({kind:'project',dataUrl,name});return '.modmind/test-output.png'},
    history:async()=>[]
  },
  app:{getPlatformInfo:()=>({platform:'win32'})},project:{listImageAssets:async()=>[]},
  resourcePacks:{},clientFailures:{record:async()=>{}},diagnostics:{recordClientFailure:async()=>{}}
}
let Workspace:React.ComponentType<any>
function Fixture(){const [dark,setDark]=useState(false);const [hidden,setHidden]=useState(false);const [project,setProject]=useState('canvas-qa');
  for(const [key,value] of Object.entries(themeCssVariables('modmind',dark?'dark':'light')))document.documentElement.style.setProperty(key,value)
  document.documentElement.dataset.theme=dark?'dark':'light'
  document.documentElement.style.colorScheme=dark?'dark':'light'
  return <><div style={{height:38,display:'flex',gap:8,padding:'4px 12px',background:'var(--theme-panel)'}}><button onClick={()=>setDark(value=>!value)}>切换主题</button><button onClick={()=>setHidden(value=>!value)}>切换页面</button><button onClick={()=>setProject(value=>value==='canvas-qa'?'canvas-qa-2':'canvas-qa')}>切换项目</button><span>图像工坊验收</span></div><aside style={{position:'absolute',top:38,left:0,bottom:0,width:180,padding:16,background:'var(--theme-panel)',borderRight:'1px solid var(--theme-line)'}}>ModMind<div style={{marginTop:24,color:'var(--theme-accent)'}}>图像工坊</div></aside><main className="image-studio-host" style={{height:'calc(100vh - 38px)',width:'calc(100vw - 180px)',marginLeft:180,padding:0}} hidden={hidden}><Workspace visible={!hidden} darkMode={dark} scopeId={project} onOpenSettings={()=>host.canvasQa.settingsOpened++}/></main></>}
host.__modmindRegisterFeature=(_id:string,module:any)=>{Workspace=module.Workspace;createRoot(document.getElementById('workspace')!).render(<Fixture/>)}
const script=document.createElement('script');script.src=location.protocol==='file:'?'../../feature-plugin-dist/image-studio/renderer.js':'/feature-plugin-dist/image-studio/renderer.js';document.head.append(script)
