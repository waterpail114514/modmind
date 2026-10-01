import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'
import { DownloadManager } from './downloadService'
import featureDescriptions from '../shared/featureDescriptions.json'
import { compareSemanticAppVersions, parseAppVersion } from './appUpdatePolicy'
import { FEATURE_PLUGIN_API, FEATURE_PLUGIN_HOST, FEATURE_PLUGIN_ARCHIVE_LIMIT, type FeaturePluginCatalogEntry, type FeaturePluginRecord } from '../shared/featurePlugins'
import { OFFICIAL_FEATURE_BASE, OFFICIAL_FEATURE_INDEX, featureGroups, type OfficialFeatureIndex, type OfficialFeatureRelease, type FeatureStoreSnapshot, type FeatureStoreJob, type FeatureRecommendationResult } from '../shared/featureStore'

const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const catalogueLimit = 1024 * 1024, packageLimit = FEATURE_PLUGIN_ARCHIVE_LIMIT, refreshInterval = 6 * 60 * 60 * 1000
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
const strings = (value: unknown, max: number, length: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, length))

/** Public HTTPS objects only. Bucket credentials never enter this protocol. */
export function validateOfficialFeatureIndex(value: unknown): OfficialFeatureIndex {
  if (!object(value) || value.format !== 'modmind-feature-catalog' || value.schemaVersion !== 1 || !text(value.generatedAt, 50) || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.features) || value.features.length > 100) throw new Error('官方功能目录格式不正确')
  const seen = new Set<string>()
  const features = value.features.map(raw => {
    if (!object(raw) || !text(raw.id,64) || !idPattern.test(raw.id) || seen.has(raw.id) || !text(raw.name,80) || !text(raw.description,1500) || !text(raw.version,80) || !parseAppVersion(raw.version) || !text(raw.hostVersion,80) || !Number.isSafeInteger(raw.apiVersion) || !text(raw.sha256,64) || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.size) || Number(raw.size) <= 0 || Number(raw.size) > packageLimit || !text(raw.publishedAt,50) || !Number.isFinite(Date.parse(raw.publishedAt)) || !strings(raw.changelog,20,500) || !strings(raw.dependencies,32,64) || raw.dependencies.some(id => !idPattern.test(id) || id === raw.id) || new Set(raw.dependencies).size !== raw.dependencies.length || !strings(raw.groups,16,40)) throw new Error('官方功能目录包含无效或重复的功能')
    if (raw.path !== `features/packages/${raw.id}/${raw.version}/${raw.sha256}.mmfeature` || /[\\/%?#]/.test(raw.version)) throw new Error('官方功能下载路径无效')
    if (raw.target !== undefined && (!object(raw.target) || !text(raw.target.platform,20) || !text(raw.target.arch,20))) throw new Error('官方功能平台信息无效')
    seen.add(raw.id)
    return structuredClone(raw) as unknown as OfficialFeatureRelease
  })
  for (const entry of features) if (entry.dependencies.some(id => !seen.has(id))) throw new Error(`官方功能目录缺少 ${entry.name} 的依赖`)
  const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(features.map(entry => [entry.id,entry]))
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error('官方功能目录存在循环依赖'); if (visited.has(id)) return; visiting.add(id); byId.get(id)!.dependencies.forEach(visit); visiting.delete(id); visited.add(id) }
  features.forEach(entry => visit(entry.id))
  return { format: 'modmind-feature-catalog', schemaVersion: 1, generatedAt: value.generatedAt, features }
}

export class FeatureStoreService {
  private index?: OfficialFeatureIndex
  private checkedAt?: string
  private checking?: Promise<FeatureStoreSnapshot>
  private lastAttempt = 0
  private error?: string
  private cached = false
  private job?: FeatureStoreJob
  private controller?: AbortController
  private receipts = new Map<string, string>()
  private readonly downloads = new DownloadManager()
  constructor(private readonly root: string, private readonly plugins: FeaturePluginService, private readonly changed: (snapshot: FeatureStoreSnapshot) => void) {}
  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    try {
      const file = path.join(this.root,'catalog.json')
      if ((await fs.stat(file)).size > catalogueLimit) throw new Error('Cache too large')
      const saved = JSON.parse(await fs.readFile(file,'utf8'))
      this.index = validateOfficialFeatureIndex(saved.index)
      this.checkedAt = typeof saved.checkedAt === 'string' && Number.isFinite(Date.parse(saved.checkedAt)) && Date.parse(saved.checkedAt) <= Date.now() ? saved.checkedAt : undefined
      this.cached = true
    } catch { /* A missing or invalid cache is rebuilt from the public index. */ }
    try { const file = path.join(this.root,'receipts.json'); if ((await fs.stat(file)).size > 64 * 1024) throw new Error('Receipts too large'); const rows: unknown = JSON.parse(await fs.readFile(file,'utf8')); if (object(rows)) for (const [id,digest] of Object.entries(rows)) if (idPattern.test(id) && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) this.receipts.set(id,digest) } catch { /* Local imports have no official receipt. */ }
    // Only our disposable downloads are cleared; installed features live elsewhere.
    for (const name of await fs.readdir(this.root)) if (/^download-[a-f0-9-]+\.mmfeature(?:\.partial[-\w]*)?$/.test(name)) await fs.rm(path.join(this.root,name),{force:true}).catch(()=>undefined)
  }
  private incompatible(entry: OfficialFeatureRelease): string | undefined {
    if (entry.apiVersion !== FEATURE_PLUGIN_API || entry.hostVersion !== FEATURE_PLUGIN_HOST) return '需要其他版本的 ModMind'
    if (entry.target && (entry.target.platform !== process.platform || entry.target.arch !== process.arch)) return '暂不支持当前系统或架构'
    return undefined
  }
  snapshot(): FeatureStoreSnapshot {
    const local = new Map(this.plugins.catalog().map(entry => [entry.id,entry]))
    const remote = new Map(this.index?.features.map(entry => [entry.id,entry]) ?? [])
    return {
      entries: [...new Set([...local.keys(),...remote.keys()])].map(id => {
        const entry = local.get(id), release = remote.get(id)
        const base: FeaturePluginCatalogEntry = entry ?? { id, name: release!.name, version: release!.version, enabled:false, installed:false, available:false, state:'not-installed', installHint:'侧边栏 → 功能' }
        const groups = entry?.manifest ? featureGroups(entry.manifest) : release?.groups ?? []
        const incompatible = release ? this.incompatible(release) : undefined
        return { ...base, name: release?.name ?? base.name, description: release?.description ?? (featureDescriptions as Record<string,string>)[id] ?? entry?.manifest?.capabilities?.map(value=>value.description).join('；') ?? 'ModMind 应用功能', groups: groups.length ? groups : ['支持组件'], release, incompatible, updateAvailable: Boolean(release && !incompatible && entry?.installed && (compareSemanticAppVersions(release.version,entry.version) ?? 0) > 0) }
      }), checking: Boolean(this.checking), checkedAt:this.checkedAt, error:this.error, cached:this.cached, job:this.job ? {...this.job} : undefined
    }
  }
  publish(): void { this.changed(this.snapshot()) }
  agentCatalog(): FeaturePluginCatalogEntry[] {
    return this.snapshot().entries.map(entry => ({...entry, download:{available:Boolean(entry.release && !entry.incompatible),latestVersion:entry.release?.version,updateAvailable:entry.updateAvailable,message:entry.incompatible ?? (!entry.release ? this.error ?? '官方目录尚未发布' : undefined)}}))
  }
  async refresh(force = false): Promise<FeatureStoreSnapshot> {
    if (this.checking) return this.checking
    if (!force && this.checkedAt && Date.now()-Date.parse(this.checkedAt)<refreshInterval || Date.now()-this.lastAttempt<5000) return this.snapshot()
    this.lastAttempt=Date.now()
    this.checking=this.loadIndex()
    this.publish()
    try { await this.checking } finally { this.checking=undefined; this.publish() }
    return this.snapshot()
  }
  private async loadIndex(): Promise<FeatureStoreSnapshot> {
    const file=path.join(this.root,`catalog-${randomUUID()}.tmp`)
    try {
      await this.downloads.download({sources:[{id:'official-features',label:'官方功能目录',url:new URL(OFFICIAL_FEATURE_INDEX,OFFICIAL_FEATURE_BASE).href}],destination:file,maxBytes:catalogueLimit,timeoutMs:15000,retriesPerSource:2,trackActivity:false})
      const index=validateOfficialFeatureIndex(JSON.parse(await fs.readFile(file,'utf8')))
      const checkedAt=new Date().toISOString()
      await fs.writeFile(file,JSON.stringify({index,checkedAt}))
      await fs.rename(file,path.join(this.root,'catalog.json'))
      this.index=index; this.checkedAt=checkedAt; this.cached=false; this.error=undefined
    } catch(error) {
      const message=String(error)
      this.error=/HTTP 403/.test(message)?'官方功能源暂未开放访问，已安装功能仍可使用。':/HTTP 404/.test(message)?'官方功能目录尚未发布，已安装功能仍可使用。':'无法检查官方功能，请检查网络后重试。'
      this.cached=Boolean(this.index)
    } finally { await fs.rm(file,{force:true}).catch(()=>undefined) }
    return this.snapshot()
  }
  cancel(): void { if (this.job?.phase === 'downloading') this.controller?.abort(new Error('用户取消下载')) }
  shutdown(): void { this.controller?.abort(new Error('应用正在关闭')) }
  private async receipt(id: string): Promise<void> {
    const digest=this.plugins.fingerprint(id)
    if(digest)this.receipts.set(id,digest)
    const temp=path.join(this.root,`receipts-${randomUUID()}.tmp`)
    try { await fs.writeFile(temp,JSON.stringify(Object.fromEntries(this.receipts)));await fs.rename(temp,path.join(this.root,'receipts.json')) } finally { await fs.rm(temp,{force:true}).catch(()=>undefined) }
  }
  async installOfficial(id: string, options: {automatic?: boolean;signal?: AbortSignal} = {}): Promise<FeaturePluginRecord[]> {
    if (!idPattern.test(id)) throw new Error('功能标识无效')
    if (this.controller) throw new Error('请等待当前功能安装结束')
    const controller=new AbortController();this.controller=controller
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal
    this.job={id,name:this.plugins.catalog().find(entry=>entry.id===id)?.name??id,phase:'downloading',downloaded:0,total:0,message:'正在检查功能目录'};this.publish()
    try {
      await this.refresh()
      signal.throwIfAborted()
      const remote=new Map(this.index?.features.map(entry=>[entry.id,entry])??[])
      const requested=remote.get(id)
      if (!requested) throw new Error(this.error??'此功能尚未在官方源发布')
      const order:OfficialFeatureRelease[]=[], seen=new Set<string>()
      const visit=(key:string):void=>{if(seen.has(key))return;seen.add(key);const entry=remote.get(key);if(!entry)throw new Error(`缺少依赖：${key}`);const why=this.incompatible(entry);if(why)throw new Error(`${entry.name}：${why}`);entry.dependencies.forEach(visit);order.push(entry)}
      visit(id)
      for(const release of order){
        signal.throwIfAborted()
        const installed=this.plugins.catalog().find(entry=>entry.id===release.id)
        const trusted=this.receipts.get(release.id)===this.plugins.fingerprint(release.id)&&this.receipts.has(release.id)
        if(installed?.available&&(options.automatic||release.id!==id))continue
        if(options.automatic&&installed?.installed&&trusted){
          if(!installed.enabled)await this.plugins.setEnabled(release.id,true,true)
          if(!this.plugins.enabled(release.id))throw new Error(`${release.name} 加载失败，请在功能页修复`)
          continue
        }
        if(installed?.installed&&(compareSemanticAppVersions(release.version,installed.version)??0)<0)throw new Error('已安装版本更新，未自动降级')
        const file=path.join(this.root,`download-${randomUUID()}.mmfeature`)
        this.job={id:release.id,name:release.name,phase:'downloading',downloaded:0,total:release.size};this.publish()
        let lastProgress=0
        try {
          const result=await this.downloads.download({sources:[{id:'official-features',label:'ModMind 官方功能',url:new URL(release.path,OFFICIAL_FEATURE_BASE).href}],destination:file,expectedHash:{algorithm:'sha256',value:release.sha256},maxBytes:release.size,timeoutMs:10*60*1000,retriesPerSource:2,activityLabel:`安装${release.name}`,signal,onProgress:({downloaded})=>{if(this.job)this.job.downloaded=downloaded;if(Date.now()-lastProgress>250){lastProgress=Date.now();this.publish()}}})
          if(result.bytes!==release.size)throw new Error('功能包大小与官方目录不一致')
          const prepared=await prepareFeaturePlugin(file),manifest=prepared.manifest
          if(manifest.id!==release.id||manifest.version!==release.version||manifest.apiVersion!==release.apiVersion||manifest.hostVersion!==release.hostVersion||JSON.stringify([...(manifest.dependencies??[])].sort())!==JSON.stringify([...release.dependencies].sort()))throw new Error('功能包身份或依赖与官方目录不一致')
          signal.throwIfAborted()
          this.job.phase='installing';this.job.downloaded=release.size;this.publish()
          if(installed?.installed){
            if(options.automatic){
              const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
              if(digest!==this.plugins.fingerprint(release.id))throw new Error('现有功能需要替换，请结束任务后在功能页更新')
            }else await this.plugins.update(prepared)
            if(!installed.enabled&&(options.automatic||release.id!==id))await this.plugins.setEnabled(release.id,true,Boolean(options.automatic))
          }else await this.plugins.install(prepared,Boolean(options.automatic))
          // The verified installed files remain authoritative if the receipt cache cannot be persisted.
          await this.receipt(release.id).catch(()=>undefined)
          if(this.plugins.enabled(release.id))this.plugins.service(release.id)
        }finally{await fs.rm(file,{force:true}).catch(()=>undefined)}
      }
      this.job={id,name:requested.name,phase:'done',downloaded:0,total:0,message:this.plugins.enabled(id)?'已安装并启用':'已更新，保持停用'}
      return this.plugins.list()
    }catch(error){this.job={...(this.job??{id,name:id,downloaded:0,total:0}),id,phase:signal.aborted?'cancelled':'error',message:signal.aborted?'已取消，已安装的功能会保留':error instanceof Error?error.message:String(error)};throw error}
    finally{this.controller=undefined;this.publish()}
  }
  async recommend(input: unknown, automatic: boolean, signal?: AbortSignal): Promise<FeatureRecommendationResult> {
    if(!object(input)||Object.keys(input).some(key=>key!=='recommendations')||!Array.isArray(input.recommendations)||input.recommendations.length<1||input.recommendations.length>6)throw new Error('推荐清单须包含 1–6 项功能及推荐原因')
    const seen=new Set<string>()
    const selected=input.recommendations.map(value=>{if(!object(value)||Object.keys(value).some(key=>!['id','reason'].includes(key))||!text(value.id,64)||!idPattern.test(value.id)||seen.has(value.id)||!text(value.reason,400))throw new Error('推荐功能或推荐原因无效');seen.add(value.id);return{id:value.id,reason:value.reason.trim()}})
    await this.refresh()
    const known=new Map(this.snapshot().entries.map(entry=>[entry.id,entry]))
    if(selected.some(entry=>!known.has(entry.id)))throw new Error('仅能推荐 ModMind 官方目录中已知的功能')
    const recommendations:FeatureRecommendationResult['recommendations']=[]
    for(const value of selected){
      signal?.throwIfAborted()
      const entry=known.get(value.id)!
      if(this.plugins.enabled(value.id)){recommendations.push({...value,name:entry.name,status:'ready'});continue}
      if(!automatic){recommendations.push({...value,name:entry.name,status:'manual',message:entry.incompatible??(!entry.release?this.error??'官方目录尚未发布':'在侧边栏「功能」中安装')});continue}
      try{await this.installOfficial(value.id,{automatic:true,signal});recommendations.push({...value,name:entry.name,status:'installed'})}
      catch(error){if(signal?.aborted)throw error;recommendations.push({...value,name:entry.name,status:'failed',message:error instanceof Error?error.message:String(error)})}
    }
    return {mode:automatic?'automatic':'manual',recommendations,tools:this.plugins.tools('workbench').filter(tool=>seen.has(tool.pluginId)),instruction:automatic?'用表格向用户列出推荐功能、任务相关原因和真实安装结果。失败时说明原因，不声称安装成功；成功后可用返回的 tools 参数说明，通过 modmind_feature_call 立即继续任务。':'用表格向用户列出推荐功能和任务相关原因，引导用户到侧边栏「功能」安装。不要声称已经安装，不用外部软件替代。'}
  }
}
