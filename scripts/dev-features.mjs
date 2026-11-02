import {watch} from 'node:fs'
import {access,copyFile,mkdir,open,readFile,readdir,rename,unlink,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'

export const root=path.resolve(import.meta.dirname,'..')
export const devRoot=path.join(root,'node_modules/.cache/modmind-feature-dev')
const exists=file=>access(file).then(()=>true,()=>false)
const log=message=>console.log(`[功能开发] ${message}`)
async function writeBuildState(base,state){
 const temporary=path.join(base,`ready-${randomUUID()}.tmp`)
 await writeFile(temporary,JSON.stringify(state,null,2))
 try{for(let attempt=0;;attempt++){try{await rename(temporary,path.join(base,'ready.json'));break}catch(error){if(!['EBUSY','EPERM','EACCES'].includes(error.code)||attempt>=6)throw error;await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)))}}}finally{await unlink(temporary).catch(()=>{})}
}

export async function selectedFeatures(requested) {
  const manifests=new Map()
  for(const entry of await readdir(path.join(root,'feature-plugins'),{withFileTypes:true})) {
    const file=path.join(root,'feature-plugins',entry.name,'manifest.json')
    if(entry.isDirectory()&&await exists(file))manifests.set(entry.name,JSON.parse(await readFile(file,'utf8')))
  }
  const builtins=new Set(JSON.parse(await readFile(path.join(root,'src/shared/bundledStudios.json'),'utf8')))
  const ids=requested?requested.split(','):[...manifests.keys()].filter(id=>!builtins.has(id))
  if(!ids.length||ids.some(id=>!/^[a-z][a-z0-9-]{0,63}$/.test(id)||!manifests.has(id)||builtins.has(id)))throw new Error('请用 --only=id 或 --only=id1,id2 选择仓库中的可选功能；内置工作台使用 npm run dev')
  const result=[],visiting=new Set(),visited=new Set()
  const visit=id=>{
    if(builtins.has(id)||visited.has(id))return
    if(visiting.has(id)||!manifests.has(id))throw new Error('功能依赖缺失或存在循环：'+id)
    visiting.add(id)
    for(const dependency of manifests.get(id).dependencies??[])visit(dependency)
    visiting.delete(id);visited.add(id);result.push(manifests.get(id))
  }
  ids.forEach(visit)
  return result
}

export async function publishBuild(manifest,base=devRoot) {
  const archive=path.join(base,'build',manifest.id+(manifest.studios?.length?'.mmstudio':'.mmfeature'))
  const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex')
  await mkdir(path.join(base,'packages'),{recursive:true})
  const published=`packages/${manifest.id}-${sha256}.zip`
  if(!await exists(path.join(base,published)))await copyFile(archive,path.join(base,published))
  let state={version:1,builds:[]}
  try{state=JSON.parse(await readFile(path.join(base,'ready.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  const previous=state.builds.find(item=>item.id===manifest.id)
  if(previous?.sha256!==sha256){
    state.builds=state.builds.filter(item=>item.id!==manifest.id)
    state.builds.push({id:manifest.id,archive:published,sha256})
    await writeBuildState(base,state)
  }
  // Keep a bounded set of completed packages. Installed copies live in the isolated profile.
  const retired=(await readdir(path.join(base,'packages'))).filter(name=>name.startsWith(manifest.id+'-')&&/^[a-z][a-z0-9-]*-[a-f0-9]{64}\.zip$/.test(name)&&`packages/${name}`!==published)
  for(const name of retired.slice(0,Math.max(0,retired.length-2)))await unlink(path.join(base,'packages',name)).catch(()=>{})
  return previous?.sha256!==sha256
}

export class FeatureBuildQueue {
  pending=new Set();running=false;closed=false;timer=undefined;idle=[]
  constructor(build,delay=250){this.build=build;this.delay=delay}
  enqueue(ids){if(this.closed)return;ids.forEach(id=>this.pending.add(id));clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.drain()},this.delay)}
  async drain(){
    if(this.running||this.closed)return
    clearTimeout(this.timer);this.running=true
    try{while(this.pending.size&&!this.closed){const ids=[...this.pending];this.pending.clear();for(const id of ids){if(this.closed)break;try{await this.build(id)}catch(error){log(`${id} 构建失败，继续保留上一版：${error.message}`)}}}}
    finally{this.running=false;this.idle.splice(0).forEach(resolve=>resolve())}
  }
  settled(){return this.running||this.pending.size?new Promise(resolve=>this.idle.push(resolve)):Promise.resolve()}
  close(){this.closed=true;clearTimeout(this.timer);this.pending.clear();if(!this.running)this.idle.splice(0).forEach(resolve=>resolve())}
}

export async function startFeatureDevelopment(args=process.argv.slice(2)) {
  if(args.includes('--help')){console.log('npm run dev:features -- --only=image-studio[,resource-packs]\n省略 --only 开发全部可选功能。--watch-only 只构建并监听，不启动桌面应用。');return}
  const manifests=await selectedFeatures(args.find(arg=>arg.startsWith('--only='))?.slice(7)),byId=new Map(manifests.map(manifest=>[manifest.id,manifest]))
  await mkdir(devRoot,{recursive:true})
  const lockFile=path.join(devRoot,'runner.lock')
  let lock
  try{lock=await open(lockFile,'wx')}catch(error){
    if(error.code!=='EEXIST')throw error
    const pid=Number(await readFile(lockFile,'utf8'));let alive=Number.isInteger(pid)&&pid>0
    if(alive){try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')alive=false;else throw error}}
    if(alive)throw new Error('已有功能开发监听进程运行，请先结束原终端中的 dev:features')
    await unlink(lockFile);lock=await open(lockFile,'wx')
  }
  await lock.writeFile(String(process.pid))
  const children=new Set(),watchers=[],inputs=new Map(),assetRoots=new Map()
  let stopped=false,appChild
  const run=(script,argv=[],env={})=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,script),...argv],{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});children.add(child)
    child.once('error',reject);child.once('exit',code=>{children.delete(child);code===0?resolve():reject(new Error(`${script} 退出码 ${code}`))})
  })
  const build=async id=>{
    const started=Date.now();log(`构建 ${id}…`)
    await run('scripts/build-feature-plugins.mjs',['--dev',`--only=${id}`])
    const manifest=JSON.parse(await readFile(path.join(root,'feature-plugins',id,'manifest.json'),'utf8'))
    byId.set(id,manifest)
    const metadata=JSON.parse(await readFile(path.join(devRoot,'build',id,'build-inputs.json'),'utf8'))
    inputs.set(id,new Set([...metadata.main,...metadata.renderer].filter(file=>!file.startsWith('host-')).map(file=>path.resolve(root,file))))
    assetRoots.set(id,Object.values(manifest.assets??{}).map(file=>path.resolve(root,file)))
    const changed=await publishBuild(manifest)
    log(`${id} ${changed?'已构建，等待客户端加载':'内容未变化'} (${((Date.now()-started)/1000).toFixed(1)}s)`)
  }
  const queue=new FeatureBuildQueue(build)
  const stop=async()=>{
    if(stopped)return;stopped=true;queue.close();watchers.forEach(watcher=>watcher.close())
    await Promise.all([...children].map(child=>new Promise(resolve=>{
      if(!child.pid){resolve();return}
      if(process.platform==='win32'){const killer=spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});killer.once('error',()=>{child.kill();resolve()});killer.once('exit',resolve)}
      else{child.once('exit',resolve);child.kill('SIGTERM')}
    })))
    await lock.close();await unlink(lockFile).catch(()=>{})
  }
  const signal=()=>{void stop().finally(()=>process.exit(0))}
  process.once('SIGINT',signal);process.once('SIGTERM',signal)
  try{
    let state={version:1,builds:[]}
    try{state=JSON.parse(await readFile(path.join(devRoot,'ready.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    state.builds=state.builds.filter(build=>byId.has(build.id))
    await writeBuildState(devRoot,state)
    // Register before the first build so edits made during startup are not missed.
    const onChange=(directory,name)=>{
      if(!name||stopped)return
      const file=path.resolve(directory,String(name)),relative=path.relative(root,file).replaceAll('\\','/')
      if(relative==='feature-plugins/image-studio/vendor/open-canvas/canvas-utilities.css'||relative==='src/shared/featurePluginCatalog.json'||/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)||/(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(relative))return
      const affected=[...byId.keys()].filter(id=>file.startsWith(path.join(root,'feature-plugins',id)+path.sep)||inputs.get(id)?.has(file)||assetRoots.get(id)?.some(dir=>file===dir||file.startsWith(dir+path.sep))||relative.startsWith('feature-plugins/sdk/')||['scripts/build-feature-plugins.mjs','scripts/build-image-canvas-css.mjs','package-lock.json'].includes(relative))
      if(affected.length)queue.enqueue(affected)
    }
    for(const relative of ['feature-plugins','src','scripts']){const directory=path.join(root,relative);const watcher=watch(directory,{recursive:true},(_event,name)=>onChange(directory,name));watcher.on('error',error=>{log('监听失败：'+error.message);void stop()});watchers.push(watcher)}
    const packageWatcher=watch(root,(_event,name)=>onChange(root,name));watchers.push(packageWatcher)
    queue.enqueue(manifests.map(manifest=>manifest.id));await queue.drain()
    log('监听中：'+manifests.map(manifest=>manifest.id).join(', '));log('独立开发数据目录：'+path.join(devRoot,'profile'))
    if(!args.includes('--watch-only')){
      await run('scripts/verify-workspace.mjs');await run('scripts/prepare-bundled-studios.mjs');await run('scripts/prepare-developer-kit.mjs')
      const env={...process.env,MODMIND_FEATURE_DEV:path.join(devRoot,'ready.json')};delete env.ELECTRON_RUN_AS_NODE;delete env.MODMIND_DEVELOPER_HOST_CONFIG
      appChild=spawn(process.execPath,[path.join(root,'scripts/run-electron-vite.mjs'),'dev','--watch'],{cwd:root,env,stdio:'inherit',windowsHide:true});children.add(appChild)
      appChild.once('error',error=>{log(error.message);void stop()});appChild.once('exit',()=>{children.delete(appChild);void stop()})
    }
    return {stop,queue,manifests}
  }catch(error){await stop();throw error}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await startFeatureDevelopment().catch(error=>{console.error('[功能开发] '+error.message);process.exitCode=1})
