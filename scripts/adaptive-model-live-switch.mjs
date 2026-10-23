import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Explicit, reversible account routing check. No inference or image lease.
if (!process.argv.includes('--execute')) throw new Error('Use --execute to run the authorized live roundtrip')
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results', 'adaptive-model-implementation-20261017', 'live-switch')
const profile = process.env.MODMIND_LIVE_PROFILE || path.join(process.env.APPDATA, 'modmind')
const helperProfile = path.join(output, 'helper-profile')
await fs.mkdir(helperProfile, { recursive: true })
const localState = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'))
await fs.writeFile(path.join(helperProfile, 'Local State'), JSON.stringify({ os_crypt: Object.fromEntries(Object.entries(localState.os_crypt ?? {}).filter(([key, value]) => key.endsWith('encrypted_key') && typeof value === 'string')) }))
const helper = String.raw`
if(!process.argv.includes('--execute'))throw new Error('Explicit --execute required');
const {app,safeStorage}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');const {createHash,randomUUID}=require('node:crypto');
app.setName('ModMind Authorized Routing Check');app.setPath('userData',path.join(__dirname,'helper-profile'));
const source=process.env.MODMIND_LIVE_PROFILE,site=process.env.MODMIND_LIVE_SITE;
const file=path.join(source,'device-credentials.json'),marker=path.join(source,'routing-live-check-recovery.enc');
const report={checkedAt:new Date().toISOString(),site,steps:[],inferenceRequests:0,imageLeases:0,restored:false};
const hash=value=>createHash('sha256').update(value).digest('hex');
const route=data=>({account:data.account||data.provider,group:data.current??data.group??null});
const equal=(a,b)=>a.account===b.account&&a.group===b.group;
let token,original,initialStored,localHash,lastCredentials;
async function atomic(target,text){const temporary=target+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,text,{mode:0o600});try{await fs.rename(temporary,target)}finally{await fs.rm(temporary,{force:true}).catch(()=>{})}}
async function request(endpoint,body){
  const response=await fetch(site+endpoint,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'X-ModMind-Sync-Capabilities':'provider-ls',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const root=await response.json().catch(()=>null);return{status:response.status,ok:response.ok&&root?.success===true,data:root?.data,flags:{multiProviderSyncRequired:root?.multiProviderSyncRequired===true||root?.data?.multiProviderSyncRequired===true,routingSessionRequired:root?.routingSessionRequired===true||root?.data?.routingSessionRequired===true}};
}
async function snapshot(){const result=await request('/api/device/group?credentials=1');if(!result.ok||!result.data)throw new Error('STATE_'+result.status);return result.data}
async function persist(data){
  const c=data.credentials??data;
  if(typeof c.apiKey!=='string'||!c.apiKey||c.username!==initialStored.username||!/^\d+$/.test(String(c.balanceCents)))throw new Error('INVALID_CREDENTIALS');
  const url=new URL(c.inferenceBaseUrl||c.baseUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('INVALID_ENDPOINT');
  const currentText=await fs.readFile(file,'utf8');if(hash(currentText)!==localHash)throw new Error('LOCAL_PROFILE_CHANGED');
  const current=JSON.parse(currentText),next={...current,baseUrl:url.toString().replace(/\/$/,''),encryptedApiKey:safeStorage.encryptString(c.apiKey).toString('base64'),account:c.account||c.provider,group:c.group??null,node:c.node??undefined,balanceCents:String(c.balanceCents)};
  if(next.usage)next.usage={...next.usage,balanceCents:next.balanceCents,keyStatus:c.keyStatus||next.usage.keyStatus};
  if(current.encryptedConnections){
    const refreshed=await request('/api/device/providers?credentials=1');if(!refreshed.ok||refreshed.data?.protocolVersion!==2||!Array.isArray(refreshed.data.connections))throw new Error('SYNC_REFRESH_FAILED');
    const previous=JSON.parse(safeStorage.decryptString(Buffer.from(current.encryptedConnections,'base64')));
    next.encryptedConnections=safeStorage.encryptString(JSON.stringify({...refreshed.data,...(previous.bindings?{bindings:previous.bindings}:{}),...(previous.defaults?{defaults:previous.defaults}:{})})).toString('base64');
  }
  const text=JSON.stringify(next,null,2);await atomic(file,text);localHash=hash(text);lastCredentials=c;
}
async function models(data,label){
  const c=data.credentials??data,base=(c.inferenceBaseUrl||c.baseUrl).replace(/\/$/,''),url=base+(/\/v1$/i.test(base)?'':'/v1')+'/models';
  try{const response=await fetch(url,{headers:{Authorization:'Bearer '+c.apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});const value=await response.json().catch(()=>null),raw=Array.isArray(value?.data)?value.data:Array.isArray(value?.models)?value.models:[];report.steps.push({action:label,status:response.status,route:route(c),modelCount:raw.length,chatModels:raw.map(m=>typeof m==='string'?m:m.id).filter(id=>typeof id==='string'&&!/^(codex-auto-review|gpt-image)/i.test(id))});return response.ok}catch(error){report.steps.push({action:label,errorType:error.name});return false}
}
async function switchTo(target,label){
  const before=await snapshot();if(before.keyStatus!=='ACTIVE')throw new Error('KEY_NOT_ACTIVE');
  const expected=route(before);
  await atomic(marker,safeStorage.encryptString(JSON.stringify({version:1,original,initialStored,token,pending:target,at:new Date().toISOString()})).toString('base64'));
  let result;
  try{result=await request('/api/device/group',{...(target.account!==expected.account?{account:target.account}:{}),...(target.group!==null?{group:target.group}:{}),expectedAccount:expected.account,expectedGroup:expected.group});report.steps.push({action:label,status:result.status,from:expected,target,...result.flags})}
  catch(error){report.steps.push({action:label,errorType:error.name,from:expected,target})}
  let current=await snapshot();
  for(let attempt=0;current.keyStatus!=='ACTIVE'&&attempt<5;attempt++){await new Promise(resolve=>setTimeout(resolve,2000));current=await snapshot()}
  report.steps.push({action:label+'-readback',route:route(current),keyStatus:current.keyStatus});
  if(current.keyStatus!=='ACTIVE')throw new Error('KEY_PENDING');
  if(!equal(route(current),expected)||result?.ok)await persist(current);
  return{changed:equal(route(current),target),data:current,result};
}
app.whenReady().then(async()=>{
 try{
  if(!safeStorage.isEncryptionAvailable())throw new Error('ENCRYPTION_UNAVAILABLE');
  const initialText=await fs.readFile(file,'utf8');localHash=hash(initialText);initialStored=JSON.parse(initialText);
  if(initialStored.provider==='custom'||new URL(initialStored.siteUrl).origin!==site)throw new Error('OFFICIAL_ACCOUNT_REQUIRED');
  const session=JSON.parse(safeStorage.decryptString(Buffer.from(await fs.readFile(path.join(source,'quota-routing-session.enc'),'utf8'),'base64')));
  if(session.owner!==hash(site+'\0'+initialStored.username)||session.expiresAt<=Date.now()||typeof session.token!=='string'||!session.token)throw new Error('VALID_SESSION_REQUIRED');token=session.token;
  if(session.pending)throw new Error('EXISTING_SWITCH_PENDING');
  const state=await snapshot();original=route(state);report.original=original;
  if(state.keyStatus!=='ACTIVE')throw new Error('KEY_NOT_ACTIVE');
  const providers=Array.isArray(state.providers)?state.providers:[];
  const target=providers.find(p=>p.account==='secondary'&&p.account!==original.account&&p.kind==='paid')||providers.find(p=>p.account!==original.account&&p.kind==='paid');
  if(!target||!target.groups?.length||state.canSwitchProvider!==true)throw new Error('NO_SWITCHABLE_PROVIDER');
  const group=target.groups.find(g=>g.id==='gpt-pro（混池）')||target.groups[0];
  const switched=await switchTo({account:target.account,group:group.id},'cross-provider');
  report.crossProviderSupported=switched.changed;
  if(switched.changed)await models(switched.data,'target-models');
  else if(switched.result?.status===409){
   const own=providers.find(p=>p.account===original.account),other=own?.groups?.find(g=>g.id!==original.group);
   if(other&&state.canSwitch===true){const grouped=await switchTo({account:original.account,group:other.id},'same-provider-group');report.groupSwitchSupported=grouped.changed;if(grouped.changed)await models(grouped.data,'target-group-models')}
  }
 }catch(error){report.error=error.message&&/^[A-Z0-9_]+$/.test(error.message)?error.message:error.name}
 finally{
  if(original&&token){
   try{
    let current=await snapshot();
    if(!equal(route(current),original)){const restored=await switchTo(original,'restore');current=restored.data}
    report.restored=equal(route(current),original)&&current.keyStatus==='ACTIVE';
    if(report.restored){
      // New model keys may differ after a roundtrip; persist the latest restored tuple.
      const key=safeStorage.decryptString(Buffer.from(JSON.parse(await fs.readFile(file,'utf8')).encryptedApiKey,'base64'));
      if(current.credentials?.apiKey!==key)await persist(current);
      report.final=route(current);report.finalModelsVerified=await models(current,'restored-models');
      await fs.rm(marker,{force:true});
    }
   }catch(error){report.restoreError=error.message&&/^[A-Z0-9_]+$/.test(error.message)?error.message:error.name}
  }
  await fs.writeFile(path.join(__dirname,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.restored?0:1);
 }
});
`
const helperFile = path.join(output, 'check.cjs')
await fs.writeFile(helperFile, helper)
const site = new URL(JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8')).siteUrl).origin
const env = { ...process.env, MODMIND_LIVE_PROFILE: profile, MODMIND_LIVE_SITE: site }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--no-error-dialogs', helperFile, '--execute'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.resume()
const code = await new Promise(resolve => child.once('exit', resolve))
await fs.rm(path.join(helperProfile, 'Local State'), { force: true })
console.log(stdout.trim()); process.exitCode = code ?? 1
