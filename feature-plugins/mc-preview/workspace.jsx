import React from 'react'
import * as deepslateNS from '../../vendor/mc-offline-tool/preview/vendor/deepslate.umd.cjs'
import * as glMatrixNS from '../../vendor/mc-offline-tool/preview/vendor/gl-matrix.js'
import { useConfirmDialog, usePromptDialog } from '../../src/renderer/src/components/InteractionDialogs'
import { setHost, setRoot } from '../../vendor/mc-offline-tool/preview/src/host.js'
import * as legacy from '../../vendor/mc-offline-tool/preview/src/projects.js'
import { TEMPLATE } from './workspace-template.js'
import { CSS } from './workspace-style.js'
import { scrollbarStyles } from '../../src/shared/scrollbars'
import GameResourceSources from '../sdk/GameResourceSources'

globalThis.deepslate = deepslateNS.default || deepslateNS
globalThis.glMatrix = glMatrixNS.default || glMatrixNS
const toBase64 = bytes => { let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value); }
const toBytes = value => Uint8Array.from(atob(value),ch=>ch.charCodeAt(0))
// The original viewer uses module state. Serialize remounts, including pending saves.
let lifecycle = Promise.resolve()
const pendingDrafts = new Map()

function PreviewWorkspace(props) {
  const ref = React.useRef(null)
  const {confirm,dialog:confirmDialog} = useConfirmDialog()
  const {prompt,dialog:promptDialog} = usePromptDialog()
  const [recover,setRecover] = React.useState(false)
  const [recoveryError,setRecoveryError] = React.useState('')
  const [recovering,setRecovering] = React.useState(false)
  const [reload,setReload] = React.useState(0)
  const [resourceSources,setResourceSources] = React.useState(false)
  const resourceRefresh = React.useRef(null)
  const projectPath = props.project?.path || ''
  const invoke = (action,input={},feature='mc-preview') => window.modmind.featurePlugins.invoke(feature,action,action==='pull:chooseInstance'?input:{...input,projectPath})
  React.useEffect(() => {
    const el=ref.current
    if(!el || !projectPath)return
    const shadow=el.shadowRoot || el.attachShadow({mode:'open'})
    let disposed=false, started=false, core
    lifecycle=lifecycle.catch(()=>{}).then(async()=>{
      if(disposed)return
      shadow.innerHTML=''
      const style=document.createElement('style');style.textContent=CSS+'\n'+scrollbarStyles('var(--theme-subtle)', '.mcp-wrap')
      const wrap=document.createElement('div');wrap.className='mcp-wrap';wrap.innerHTML=TEMPLATE
      shadow.append(style,wrap)
      const $=id=>shadow.getElementById(id)
      const api = {
        kind:'feature',
        initialBuild:async()=> (await invoke('preview:open')).build,
        scene:async states=>{
          const result=await invoke('preview:scene',{states})
          if(!disposed)core?.acceptResourceVersion(result.dataVersion)
          return {...result,assets:{blockstates:result.blockstates,models:result.models,textures:result.uv},atlasUrl:result.atlas}
        },
        items:input=>invoke('preview:items',input),
        icons:async ids=>(await invoke('preview:icons',{ids})).icons,
        documents:input=>invoke('preview:documents',input),
        saveDocument:input=>invoke('preview:save',input),
        importBuild:async(name,bytes)=>(await invoke('preview:import',{name,dataBase64:toBase64(bytes)})).build,
        exportBuild:async(build,format)=>{
          const allowLossy=build.losses?.length ? await confirm({title:'导出方块建筑',message:build.losses.join('；'),detail:'导入原件已保留，可从“更多”下载。此导出仅包含方块状态。',confirmLabel:'继续导出'}) : false
          if(build.losses?.length && !allowLossy)throw new Error('已取消导出，建筑与原件均已保留')
          const result=await invoke('preview:export',{build,format,allowLossy})
          return {...result,blob:new Blob([toBytes(result.dataBase64)],{type:'application/octet-stream'})}
        },
        prompt:(title,value)=>prompt({title,value,inputLabel:'建筑名称',confirmLabel:'重命名'}),
        confirm:message=>confirm({title:'删除建筑',message,confirmLabel:'删除建筑',tone:'danger'})
      }
      setRoot(shadow);setHost(api)
      el.dataset.projectPath=projectPath
      core=await import('../../vendor/mc-offline-tool/preview/src/main.js')
      if(disposed)return
      const draft=pendingDrafts.get(projectPath)
      if(draft){await api.saveDocument({operation:'create',name:(draft.name||'建筑')+'（恢复）',build:draft});pendingDrafts.delete(projectPath)}
      started=true
      const boot=await core.boot()
      if(disposed)return
      if(!boot?.ok){const retry=document.createElement('button');retry.className='btn';retry.textContent='重新打开';retry.onclick=()=>setReload(value=>value+1);$('err').append(retry);return}
      const report=error=>{$('sourceMessage').textContent=String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');$('sourceEmpty').hidden=false}
      const refresh=async()=>{try{await core.reloadInventory()}catch(error){report(error)}}
      resourceRefresh.current = refresh
      let capturing=false
      const choose=async()=>{
        if(capturing)return
        try {
          const {instanceDir}=await invoke('pull:chooseInstance',{},'mc-pull')
          if(!instanceDir || disposed)return
          capturing=true
          $('sourceBtn').disabled=$('setupSource').disabled=true
          $('sourceEmpty').hidden=false;$('sourceMessage').textContent='正在读取所选实例的本地方块资源…'
          await invoke('pull:run',{instanceDir},'mc-pull')
          if(!disposed)await refresh()
        }catch(error){if(!disposed)report(error)}
        finally{capturing=false;if(!disposed)$('sourceBtn').disabled=$('setupSource').disabled=false}
      }
      $('sourceBtn').onclick=()=>setResourceSources(true)
      $('setupSource').onclick=choose
      $('retrySource').onclick=refresh
      $('originalBtn').onclick=()=>{
        const original=core.currentBuild()?.original
        if(!original){$('msg').textContent='当前建筑没有导入原件';return}
        const url=URL.createObjectURL(new Blob([toBytes(original.dataBase64)]));const a=document.createElement('a');a.href=url;a.download=original.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
      }
      $('legacyImport').hidden=legacy.list().length===0 && !localStorage.getItem(legacy.OLD_SNAP_KEY)
      $('legacyImport').onclick=()=>setRecover(true)
      el.dataset.ready='true'
    }).catch(error=>{
      if(disposed)return
      const target=shadow.getElementById('err')
      if(target){target.textContent=String(error.message || error);const retry=document.createElement('button');retry.textContent='重试';retry.className='btn';retry.onclick=()=>setReload(value=>value+1);target.append(retry)}
    })
    return()=>{
      disposed=true
      resourceRefresh.current=null
      lifecycle=lifecycle.catch(()=>{}).then(async()=>{
        if(started){const draft=core.currentBuild();const result=await core.shutdown();if(result && !result.ok && draft){if(pendingDrafts.size>=4)pendingDrafts.delete(pendingDrafts.keys().next().value);pendingDrafts.set(projectPath,draft)}}
        delete el.dataset.ready;delete el.dataset.projectPath
      })
    }
  },[projectPath,reload])
  const recoveryEntries=legacy.list()
  const recoverOne=async id=>{
    setRecovering(true);setRecoveryError('')
    try {
      const build=id==='autosave'?JSON.parse(localStorage.getItem(legacy.OLD_SNAP_KEY)).build:legacy.load(id)
      if(!build)throw new Error('旧存档无法读取，原数据已保留')
      await invoke('preview:save',{operation:'create',name:build.name || recoveryEntries.find(entry=>entry.id===id)?.name || '恢复的建筑',build})
      setRecover(false);setReload(value=>value+1)
    }catch(error){setRecoveryError(String(error.message || error))}finally{setRecovering(false)}
  }
  return <>
    <div ref={ref} className="mcp-host" style={{height:'100%',minHeight:0,minWidth:0,position:'relative',containerType:'inline-size'}} />
    {confirmDialog}{promptDialog}
    {resourceSources?<GameResourceSources projectPath={projectPath} onChanged={()=>{void resourceRefresh.current?.()}} onClose={()=>setResourceSources(false)}/>:null}
    {recover?<div className="modal-backdrop"><div className="dialog" role="dialog" aria-modal="true" aria-label="恢复旧版建筑存档"><h3>恢复到当前项目</h3><p>选择要恢复的建筑。旧存档会保留。</p>{recoveryEntries.map(entry=><button className="secondary-button" key={entry.id} disabled={recovering} onClick={()=>recoverOne(entry.id)}>{entry.name} · {entry.blocks} 方块</button>)}{localStorage.getItem(legacy.OLD_SNAP_KEY)?<button className="secondary-button" disabled={recovering} onClick={()=>recoverOne('autosave')}>恢复上次会话</button>:null}{recoveryError?<p role="alert">{recoveryError}</p>:null}<div className="dialog-footer"><button className="secondary-button" disabled={recovering} onClick={()=>setRecover(false)}>关闭</button></div></div></div>:null}
  </>
}
window.__modmindRegisterFeature('mc-preview',{PreviewWorkspace})
