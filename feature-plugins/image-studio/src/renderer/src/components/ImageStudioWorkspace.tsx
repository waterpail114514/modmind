import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Eraser, FolderOpen, Grid3X3, ImageIcon, LoaderCircle, Plus, Save, Settings2, Sparkles, Undo2, Upload } from 'lucide-react'
import type { ImageAsset, PerfectPixelOptions, PerfectPixelSampleMethod } from '../../../../../../src/shared/imageStudio'
import type { ResourceImageTarget } from '../../../../../../src/shared/resourcePack'
import MiniPaintEditor from '../../../../../../src/renderer/src/components/MiniPaintEditor'
import { reportClientFailure } from '../../../../../../src/renderer/src/lib/clientFailure'
import { tracedImageStudio } from '../lib/imageStudioTrace'
import '@xyflow/react/dist/style.css'
import '../../../../vendor/open-canvas/components/open-canvas/workspace.css'
import '../../../../vendor/open-canvas/canvas-utilities.css'
import './image-canvas-host.css'

const Canvas = lazy(() => import('../../../../vendor/open-canvas/components/open-canvas/workspace'))
type StudioTab = 'workflow' | 'process' | 'edit'
const defaultPerfectPixelOptions: PerfectPixelOptions = {sampleMethod:'center',minSize:4,peakWidth:6,refineIntensity:.3,fixSquare:true}
function errorText(error:unknown) { return reportClientFailure(error) }
function readFileAsDataUrl(file:File):Promise<string> { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('读取图片失败'));reader.onload=()=>resolve(String(reader.result));reader.readAsDataURL(file);}); }
function createBlankImageAsset(): ImageAsset {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1024
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建编辑画布')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  return { id: crypto.randomUUID(), dataUrl: canvas.toDataURL('image/png'), createdAt: new Date().toISOString(), model: 'blank-canvas', style: 'free', size: '1024x1024', quality: 'auto', hosted: false, credits: 0 }
}
function PerfectPixelControls({ value, onChange }: { value?: PerfectPixelOptions; onChange: (value: PerfectPixelOptions) => void }): React.JSX.Element {
  const current = { ...defaultPerfectPixelOptions, ...value }
  const update = (patch: Partial<PerfectPixelOptions>): void => onChange({ ...current, ...patch })
  const gridSize = current.gridSize || [16, 16]
  return <div className="image-perfect-pixel-options"><strong>PerfectPixel 参数</strong>
    <label className="field-label">采样方式<select value={current.sampleMethod} onChange={(event) => update({ sampleMethod: event.target.value as PerfectPixelSampleMethod })}><option value="center">中心</option><option value="majority">多数</option><option value="median">中位数</option></select></label>
    <label className="field-label">最小像素尺寸<input type="number" min={0.1} max={1000} step={0.1} value={current.minSize} onChange={(event) => update({ minSize: Number(event.target.value) || 0.1 })} /></label>
    <label className="field-label">峰值宽度<input type="number" min={1} max={1000} step={1} value={current.peakWidth} onChange={(event) => update({ peakWidth: Number(event.target.value) || 1 })} /></label>
    <label className="field-label">网格线修正强度<input type="number" min={0} max={0.5} step={0.05} value={current.refineIntensity} onChange={(event) => update({ refineIntensity: Math.min(0.5, Math.max(0, Number(event.target.value) || 0)) })} /></label>
    <label className="image-perfect-pixel-check"><input type="checkbox" checked={Boolean(current.gridSize)} onChange={(event) => update({ gridSize: event.target.checked ? [Math.max(1, gridSize[0]), Math.max(1, gridSize[1])] : undefined })} />手动指定网格尺寸</label>
    {current.gridSize ? <div className="image-perfect-pixel-grid"><label className="field-label">宽<input type="number" min={1} max={4096} step={1} value={gridSize[0]} onChange={(event) => update({ gridSize: [Math.max(1, Number(event.target.value) || 1), gridSize[1]] })} /></label><label className="field-label">高<input type="number" min={1} max={4096} step={1} value={gridSize[1]} onChange={(event) => update({ gridSize: [gridSize[0], Math.max(1, Number(event.target.value) || 1)] })} /></label></div> : null}
    <label className="image-perfect-pixel-check"><input type="checkbox" checked={current.fixSquare !== false} onChange={(event) => update({ fixSquare: event.target.checked })} />接近正方形时修正</label>
  </div>
}


export default function ImageStudioWorkspace({visible,darkMode,onOpenSettings,scopeId='application',resourceTarget,onCloseResource}:{visible:boolean;darkMode:boolean;onOpenSettings:()=>void;scopeId?:string;resourceTarget?:ResourceImageTarget|null;onCloseResource?:()=>void}):React.JSX.Element {
  const [tab,setTab]=useState<StudioTab>('workflow')
  const [active,setActive]=useState<ImageAsset|null>(null)
  const [assets,setAssets]=useState<ImageAsset[]>([])
  const [undo,setUndo]=useState<ImageAsset[]>([])
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const [perfectPixelOptions,setPerfectPixelOptions]=useState<PerfectPixelOptions>(defaultPerfectPixelOptions)
  const baseline=useRef('')
  const contextEpoch=useRef(0)
  const busyRef=useRef(false)
  const tabs=useRef<Array<HTMLButtonElement|null>>([])
  useEffect(()=>{contextEpoch.current++;setActive(null);setAssets([]);setUndo([]);setMessage('');},[scopeId])
  const accept=(asset:ImageAsset)=>{contextEpoch.current++;setAssets(current=>[asset,...current.filter(item=>item.id!==asset.id)].slice(0,30));setActive(asset);setUndo([]);}
  useEffect(()=>{
    contextEpoch.current++
    if(!resourceTarget)return
    baseline.current=resourceTarget.baseline
    accept({id:'resource:'+resourceTarget.file,dataUrl:resourceTarget.dataUrl,createdAt:'',model:'resource-pack',style:'minecraft',size:'original',quality:'auto',hosted:false,credits:0})
    setTab('process')
  },[resourceTarget])
  const saveResourceImage=async(dataUrl:string)=>{
    if(!resourceTarget)return
    const {projectPath,id,file}=resourceTarget, epoch=contextEpoch.current
    await window.modmind.resourcePacks.write(projectPath,id,file,dataUrl,baseline.current)
    const saved=await window.modmind.resourcePacks.read(projectPath,id,file)
    if(epoch!==contextEpoch.current)return
    baseline.current=saved.baseline;setMessage('已保存到资源包：'+file)
  }
  const save=async(asset:ImageAsset,project=false)=>{
    try { const destination=await (project?tracedImageStudio().saveToProject(asset.dataUrl,'modmind-image-'+Date.now()):tracedImageStudio().saveAsset(asset.dataUrl,'modmind-image-'+Date.now()));if(destination)setMessage(project?'已加入项目：'+destination:'已保存：'+destination); }
    catch(error){setMessage(errorText(error));}
  }
  useEffect(()=>{
    const action=(event:Event)=>{
      if(!visible || tab!=='workflow')return
      const detail=(event as CustomEvent<{action:string;url:string;model?:string}>).detail
      if(!detail || !detail.url.startsWith('data:image/'))return
      const asset:ImageAsset={id:crypto.randomUUID(),dataUrl:detail.url,model:detail.model||'',createdAt:new Date().toISOString(),style:'free',size:'original',quality:'auto',hosted:false,credits:0}
      if(detail.action==='process'){accept(asset);setTab('process');setMessage('');}
      else if(detail.action==='save'||detail.action==='project')void save(asset,detail.action==='project')
    }
    window.addEventListener('modmind-canvas-image-action',action)
    return()=>window.removeEventListener('modmind-canvas-image-action',action)
  },[visible,tab,scopeId])
  const upload=async(file:File)=>{
    if(!file.type.startsWith('image/') || file.size>20*1024*1024){setMessage('请选择不超过 20 MB 的图片');return;}
    const epoch=contextEpoch.current
    try{const dataUrl=await readFileAsDataUrl(file);if(epoch!==contextEpoch.current)return;accept({id:crypto.randomUUID(),dataUrl,model:'uploaded',createdAt:new Date().toISOString(),style:'free',size:'original',quality:'auto',hosted:false,credits:0});}
    catch(error){setMessage(errorText(error));}
  }
  const processActive=async(operation:'perfect-pixel'|'remove-background')=>{
    if(!active||busyRef.current)return
    busyRef.current=true;setBusy(true);const current=active,epoch=contextEpoch.current
    setMessage(operation==='perfect-pixel'?'正在优化像素…':'正在去除纯色背景…')
    try{const result=await tracedImageStudio().process(operation,current.dataUrl,operation==='perfect-pixel'?{perfectPixel:perfectPixelOptions}:undefined);if(epoch!==contextEpoch.current)return;setUndo(stack=>[...stack,current].slice(-15));setActive({...current,id:crypto.randomUUID(),dataUrl:result.dataUrl});setMessage(result.detail);}
    catch(error){if(epoch===contextEpoch.current)setMessage(errorText(error));}
    finally{busyRef.current=false;setBusy(false);}
  }
  const labels:[StudioTab,string,typeof Sparkles][]=[['workflow','生成',Sparkles],['process','处理',Grid3X3],['edit','编辑',ImageIcon]]
  return <div className="image-studio-page image-canvas-host" style={{colorScheme:darkMode?'dark':'light'}}>
    <div className="image-studio-header"><div className="image-studio-tabs" role="tablist" aria-label="图像工坊">{labels.map(([key,label,Icon],index)=><button key={key} ref={element=>{tabs.current[index]=element}} id={'image-tab-'+key} role="tab" aria-selected={tab===key} aria-controls={'image-panel-'+key} tabIndex={tab===key?0:-1} className={tab===key?'active':''} onClick={()=>setTab(key)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;setTab(labels[next][0]);tabs.current[next]?.focus();}}><Icon size={15}/>{label}</button>)}</div><button className="icon-button" title="图像服务设置" onClick={onOpenSettings}><Settings2 size={15}/></button></div>
    {resourceTarget&&<div className="resource-pack-toolbar"><span>当前资源：{resourceTarget.file}</span><div className="resource-pack-actions"><button className="primary-button" disabled={busy||!active||tab==='edit'} onClick={()=>active&&void saveResourceImage(active.dataUrl).catch(error=>setMessage(errorText(error)))}>保存到资源包</button><button className="secondary-button" disabled={busy} onClick={onCloseResource}>返回资源包</button></div></div>}
    <div id="image-panel-workflow" className="image-canvas-panel" role="tabpanel" aria-labelledby="image-tab-workflow" hidden={tab!=='workflow'}><Suspense fallback={<div className="image-canvas-loading" role="status"><LoaderCircle className="spin" size={20}/>正在打开画布…</div>}><Canvas key={scopeId} userId={scopeId} visible={visible&&tab==='workflow'} darkMode={darkMode} onSettings={onOpenSettings}/></Suspense></div>
    {tab==='process'&&<div id="image-panel-process" className="image-process-panel" role="tabpanel" aria-labelledby="image-tab-process"><div className="image-process-layout"><section className="image-process-drop" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const file=event.dataTransfer.files[0];if(file)void upload(file);}}><Upload size={28}/><strong>上传图片</strong><label className="secondary-button compact"><FolderOpen size={14}/>选择图片<input type="file" accept="image/*" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);event.target.value='';}}/></label>{assets.length>0&&<div className="image-process-sources">{assets.map(asset=><button key={asset.id} className={asset.id===active?.id?'selected':''} aria-label="选择待处理图片" onClick={()=>{setActive(asset);setUndo([]);}}><img src={asset.dataUrl} alt="待处理图片"/></button>)}</div>}</section><section className="image-process-preview"><div className="image-panel-title"><ImageIcon size={16}/>预览</div>{active?<img src={active.dataUrl} alt="待处理图片"/>:<div className="image-empty"><ImageIcon size={30}/><p>上传图片或从生成结果选择“送去处理”</p></div>}</section><aside className="image-process-tools"><div className="image-panel-title"><Grid3X3 size={16}/>工具</div><PerfectPixelControls value={perfectPixelOptions} onChange={setPerfectPixelOptions}/><button className="secondary-button image-tool-button" disabled={!active||busy} onClick={()=>void processActive('perfect-pixel')}><Grid3X3 size={15}/>PerfectPixel</button><button className="secondary-button image-tool-button" disabled={!active||busy} onClick={()=>void processActive('remove-background')}><Eraser size={15}/>纯色去背</button><button className="secondary-button image-tool-button" disabled={!undo.length||busy} onClick={()=>{const previous=undo.at(-1);if(previous){setActive(previous);setUndo(stack=>stack.slice(0,-1));setMessage('已撤销处理');}}}><Undo2 size={15}/>撤销上一步</button><button className="secondary-button image-tool-button" disabled={!active||busy} onClick={()=>setTab('edit')}><ImageIcon size={15}/>在编辑器中打开</button><button className="secondary-button image-tool-button" disabled={!active||busy} onClick={()=>active&&void save(active)}><Save size={15}/>另存为</button><button className="secondary-button image-tool-button" disabled={!active||busy} onClick={()=>active&&void save(active,true)}><FolderOpen size={15}/>加入项目</button></aside></div></div>}
    {tab==='edit'&&<div id="image-panel-edit" className="image-edit-layout" role="tabpanel" aria-labelledby="image-tab-edit">{active?<MiniPaintEditor asset={active} darkMode={darkMode} onError={setMessage} onSave={resourceTarget?saveResourceImage:undefined}/>:<div className="image-editor-empty"><ImageIcon size={25}/><h2>开始编辑图片</h2><div className="image-editor-empty-actions"><button className="primary-button" onClick={()=>accept(createBlankImageAsset())}><Plus size={16}/>新建画布</button><label className="secondary-button"><Upload size={16}/>导入图片<input type="file" accept="image/*" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);}}/></label></div></div>}</div>}
    {message&&<div className="image-studio-message" role="status">{message}<button className="icon-button" aria-label="关闭提示" onClick={()=>setMessage('')}>×</button></div>}
  </div>
}
