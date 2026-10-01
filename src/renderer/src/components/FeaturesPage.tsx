import { useEffect, useMemo, useRef, useState } from 'react'
import * as icons from 'lucide-react'
import { ArrowLeft, Check, Download, LayoutGrid, LoaderCircle, MoreHorizontal, PackagePlus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { orderedFeatureGroups, type FeatureStoreEntry } from '../../../shared/featureStore'
import type { FeaturePluginInstallPreview } from '../../../shared/featurePlugins'
import { useFeatureStore } from '../useFeatureStore'
import { refreshFeaturePlugins, useFeaturePlugins } from '../featurePlugins'
import { useConfirmDialog } from './InteractionDialogs'
import FeaturePluginInstallDialog from './FeaturePluginInstallDialog'
import './features-page.css'

const bytes = (value: number): string => value >= 1024*1024 ? `${(value/(1024*1024)).toFixed(1)} MB` : `${Math.max(1,Math.ceil(value/1024))} KB`
function status(entry: FeatureStoreEntry): string {
  return entry.incompatible ?? (entry.state==='error'?'加载失败':entry.state==='dependency-missing'?'缺少依赖':entry.updateAvailable?'可更新':entry.state==='ready'?'已启用':entry.state==='disabled'?'已停用':'未安装')
}
function FeatureIcon({entry}: {entry:FeatureStoreEntry}): React.JSX.Element {
  const name=entry.manifest?.views?.[0]?.icon
  const Icon=name?(icons as unknown as Record<string,icons.LucideIcon>)[name]??icons.Package:icons.Package
  return <span className="feature-store-icon"><Icon size={22}/></span>
}
export default function FeaturesPage({onOpen,onSettings}: {onOpen:(id:string)=>void;onSettings:(id:string)=>void}): React.JSX.Element {
  const store=useFeatureStore(), local=useFeaturePlugins()
  const [category,setCategory]=useState('全部分类'),[filter,setFilter]=useState<'all'|'installed'|'updates'>('all'),[query,setQuery]=useState('')
  const [selection,setSelection]=useState<string|null>(null),[showDetail,setShowDetail]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const [preview,setPreview]=useState<{requestId:string;preview:FeaturePluginInstallPreview}|null>(null), pending=useRef<string|null>(null)
  const {confirm,dialog}=useConfirmDialog()
  const groups=useMemo(()=>orderedFeatureGroups(store.entries),[store.entries])
  const scoped=store.entries.filter(entry=>category==='全部分类'||entry.groups.includes(category))
  const shown=scoped.filter(entry=>(filter==='all'||filter==='installed'&&entry.installed||filter==='updates'&&entry.updateAvailable)&&`${entry.name} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a,b)=>Number(b.updateAvailable)-Number(a.updateAvailable)||a.name.localeCompare(b.name,'zh-CN'))
  const selected=shown.find(entry=>entry.id===selection)??shown[0]
  const loading=Boolean(store.job&&['downloading','installing'].includes(store.job.phase))
  const locked=busy||loading
  useEffect(()=>{const off=window.modmind.featurePlugins.onInstallPreview((requestId,value)=>{if(pending.current)window.modmind.featurePlugins.confirmInstall(pending.current,false);pending.current=requestId;setPreview({requestId,preview:value})});return()=>{off();if(pending.current)window.modmind.featurePlugins.confirmInstall(pending.current,false)}},[])
  const run=async(operation:()=>Promise<unknown>):Promise<void>=>{setBusy(true);setNotice('');try{await operation();await refreshFeaturePlugins()}catch(error){setNotice(error instanceof Error?error.message:String(error))}finally{setBusy(false)}}
  const install=(entry:FeatureStoreEntry):void=>{void run(async()=>{
    if(entry.installed&&entry.available&&entry.updateAvailable&&!await confirm({title:`更新${entry.name}？`,message:'请先保存正在编辑的内容。更新会保留已保存的项目文件和设置。',confirmLabel:'更新功能'}))return
    await window.modmind.featurePlugins.installOfficial(entry.id)
  })}
  const change=(entry:FeatureStoreEntry,remove:boolean):void=>{void run(async()=>{
    if(!await confirm({title:`${remove?'卸载':'停用'}${entry.name}？`,message:'请先保存正在编辑的内容。已保存的项目文件与功能设置会保留。',confirmLabel:remove?'卸载功能':'停用功能',tone:remove?'danger':'default'}))return
    await (remove?window.modmind.featurePlugins.uninstall(entry.id):window.modmind.featurePlugins.setEnabled(entry.id,false))
  })}
  const openPage=(entry:FeatureStoreEntry):string|undefined=>Object.values(local.modules).flatMap(value=>value.pages).find(page=>entry.manifest?.views?.some(view=>view.id===page.id))?.id
  const primary=(entry:FeatureStoreEntry,prominent=false):React.JSX.Element=>{
    const className=prominent?'primary-button compact':'secondary-button compact'
    if(entry.available&&!entry.updateAvailable){const page=openPage(entry);return page?<button className={className} onClick={()=>onOpen(page)}>打开</button>:<span className="feature-installed"><Check size={13}/>已安装</span>}
    if(entry.installed&&!entry.enabled&&!entry.updateAvailable&&!entry.error)return <button className={className} disabled={locked} onClick={()=>void run(()=>window.modmind.featurePlugins.setEnabled(entry.id,true))}>启用</button>
    return <button className={className} disabled={locked||!entry.release||Boolean(entry.incompatible)} onClick={()=>install(entry)} title={entry.incompatible??(!entry.release?'官方功能源尚未发布此安装包':undefined)}>{prominent&&<Download size={14}/>}{entry.updateAvailable?prominent?`更新至 ${entry.release!.version}`:'更新':entry.installed?'修复':'安装'}</button>
  }
  const dependencies=(selected?.release?.dependencies??selected?.manifest?.dependencies??[]).map(id=>store.entries.find(entry=>entry.id===id)).filter((entry):entry is FeatureStoreEntry=>Boolean(entry))
  const error=notice||store.error
  return <div className={`features-page${showDetail?' show-feature-detail':''}`}>
    <h1 className="visually-hidden">功能</h1>
    <header className="feature-store-toolbar">
      <div className="feature-store-filters" role="group" aria-label="功能状态">
        {([['all','全部'],['installed','已安装'],['updates','可更新']] as const).map(([id,label])=><button key={id} aria-pressed={filter===id} className={filter===id?'active':''} onClick={()=>{setFilter(id);setShowDetail(false)}}>{label}<span>{scoped.filter(entry=>id==='all'||id==='installed'&&entry.installed||id==='updates'&&entry.updateAvailable).length}</span></button>)}
      </div>
      <label className="feature-store-search"><Search size={15}/><input aria-label="搜索功能" placeholder="搜索功能" value={query} onChange={event=>{setQuery(event.target.value);setShowDetail(false)}}/>{query&&<button className="icon-button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={13}/></button>}</label>
      <button className="secondary-button compact" disabled={store.checking} onClick={()=>void run(()=>window.modmind.featurePlugins.refreshStore())}><RefreshCw size={14} className={store.checking?'spin':''}/>{store.checking?'正在检查':'检查更新'}</button>
      <details className="feature-store-menu"><summary aria-label="更多功能操作" title="更多"><MoreHorizontal size={18}/></summary><div><button disabled={locked} onClick={()=>void run(()=>window.modmind.featurePlugins.install())}><PackagePlus size={15}/>从本地安装</button></div></details>
    </header>
    {error&&<div className="feature-store-notice" role="alert"><span>{error}</span><button disabled={store.checking} onClick={()=>void run(()=>window.modmind.featurePlugins.refreshStore())}>重试</button></div>}
    <div className="feature-store-body">
      <nav className="feature-store-categories" aria-label="功能分类"><span>分类</span>{['全部分类',...groups].map(group=><button key={group} aria-pressed={category===group} className={category===group?'active':''} onClick={()=>{setCategory(group);setShowDetail(false)}}><LayoutGrid size={14}/><span>{group}</span><small>{store.entries.filter(entry=>group==='全部分类'||entry.groups.includes(group)).length}</small></button>)}</nav>
      <section className="feature-store-list" aria-label="功能列表"><div className="feature-store-list-heading"><strong>{category==='全部分类'?'全部功能':category}</strong><span>{shown.length} 项功能</span></div>
        {!store.entries.length?<div className="feature-store-empty" role="status">{store.error?'功能目录暂不可用，请重试':'正在读取功能目录…'}</div>:!shown.length?<div className="feature-store-empty" role="status">没有符合条件的功能<button className="secondary-button compact" onClick={()=>{setQuery('');setFilter('all');setCategory('全部分类')}}>显示全部</button></div>:shown.map(entry=><article className={`feature-store-row${selected?.id===entry.id?' selected':''}`} key={entry.id}>
          <button className="feature-store-select" aria-label={`查看${entry.name}`} aria-pressed={selected?.id===entry.id} onClick={()=>{setSelection(entry.id);setShowDetail(true)}}><FeatureIcon entry={entry}/><span className="feature-store-copy"><span className="feature-store-name">{entry.name}{entry.updateAvailable&&<small>可更新</small>}</span><span className="feature-store-description">{entry.description}</span><span className="feature-store-meta">{entry.installed?entry.version:entry.release?.version??'待发布'}{entry.updateAvailable?` → ${entry.release!.version}`:''}</span></span></button>
          <div className="feature-store-row-action">{primary(entry)}<span>{entry.release?bytes(entry.release.size):entry.installed?status(entry):'未发布'}</span></div>
        </article>)}
      </section>
      <aside className="feature-store-detail" aria-label="功能详情">{selected?<>
        <button className="feature-store-back" onClick={()=>setShowDetail(false)}><ArrowLeft size={15}/>返回列表</button>
        <div className="feature-store-detail-heading"><FeatureIcon entry={selected}/><div><h2>{selected.name}</h2><span><ShieldCheck size={12}/>{selected.release?'ModMind 官方':'ModMind 功能'}</span></div></div>
        <p className="feature-store-intro">{selected.description}</p>
        <div className="feature-store-primary">{primary(selected,true)}</div>
        <dl className="feature-store-metadata"><div><dt>已安装版本</dt><dd>{selected.installed?selected.version:'未安装'}</dd></div><div><dt>下载大小</dt><dd>{selected.release?bytes(selected.release.size):'待发布'}</dd></div><div><dt>当前状态</dt><dd>{status(selected)}</dd></div><div><dt>适用版本</dt><dd>{selected.release?.hostVersion??selected.manifest?.hostVersion??'—'}</dd></div></dl>
        {selected.error&&<p className="feature-store-inline-error" role="alert">{selected.error}</p>}
        <section><h3>本次更新</h3>{selected.release?<><div className="feature-store-release-meta">{selected.release.version}<time>{new Date(selected.release.publishedAt).toLocaleDateString('zh-CN')}</time></div>{selected.release.changelog.length?<ul>{selected.release.changelog.map((line,index)=><li key={index}>{line}</li>)}</ul>:<p>此版本未提供更新说明。</p>}</>:<p>官方源尚未发布更新信息。</p>}</section>
        <section><h3>可以在哪里使用</h3><div className="feature-store-tags">{(selected.manifest?.views??[]).map(view=><span key={view.id}>{view.label}</span>)}{selected.manifest?.tools?.length?<span>工作台</span>:null}{selected.manifest?.actions?.some(action=>action.surfaces?.includes('inspiration'))?<span>灵感台</span>:null}{!selected.manifest?.views?.length&&!selected.manifest?.tools?.length?<span>其他功能的支持组件</span>:null}</div></section>
        <section><h3>所需组件</h3>{dependencies.length?<ul className="feature-store-dependencies">{dependencies.map(entry=><li key={entry.id}><button onClick={()=>{setCategory('全部分类');setFilter('all');setQuery('');setSelection(entry.id)}}>{entry.name}</button><span>{entry.available?'已就绪':'安装时自动下载'}</span></li>)}</ul>:<p>无需额外下载</p>}</section>
        {selected.installed&&<div className="feature-store-maintenance">{selected.manifest?.settings?.[0]&&<button onClick={()=>onSettings(selected.manifest!.settings![0].id)}>功能设置</button>}<button disabled={locked} onClick={()=>selected.enabled?change(selected,false):void run(()=>window.modmind.featurePlugins.setEnabled(selected.id,true))}>{selected.enabled?'停用':'启用'}</button><button disabled={locked} onClick={()=>change(selected,true)}>卸载</button></div>}
      </>:<div className="feature-store-empty">选择功能查看详情</div>}</aside>
    </div>
    {store.job&&<div className={`feature-store-job ${store.job.phase}`} role="status"><span>{loading?<LoaderCircle size={15} className="spin"/>:store.job.phase==='done'?<Check size={15}/>:<Download size={15}/>}<strong>{store.job.name}</strong>{store.job.phase==='downloading'?`下载中 ${bytes(store.job.downloaded)}${store.job.total?` / ${bytes(store.job.total)}`:''}`:store.job.phase==='installing'?'正在校验并安装':store.job.message}</span>{store.job.phase==='downloading'&&<button onClick={()=>void window.modmind.featurePlugins.cancelDownload()}>取消</button>}{store.job.phase==='error'&&<button disabled={busy} onClick={()=>void run(()=>window.modmind.featurePlugins.installOfficial(store.job!.id))}>重试</button>}</div>}
    <footer className="feature-store-footer"><span>{store.checkedAt?`${store.cached?'上次成功检查':'已检查'}：${new Date(store.checkedAt).toLocaleString('zh-CN')}`:'尚未成功检查更新'}</span><span>{store.entries.filter(entry=>entry.updateAvailable).length} 个功能可更新</span></footer>
    {dialog}{preview&&<FeaturePluginInstallDialog preview={preview.preview} onResolve={accepted=>{window.modmind.featurePlugins.confirmInstall(preview.requestId,accepted);pending.current=null;setPreview(null)}}/>}
  </div>
}
