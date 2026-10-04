// Manual, serial probe of a user-authorized test account. Never logs credentials.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(process.env.LOCALAPPDATA, 'ModMindRoutingProbe', '20261002')
const secretFile = path.join(root, 'session.dpapi')
const reportRoot = path.join(import.meta.dirname, 'route-probe')
const site = new URL(JSON.parse(await fs.readFile(new URL('../../resources/service-config.json', import.meta.url), 'utf8')).siteUrl).origin
await fs.mkdir(root, { recursive: true })
await fs.mkdir(reportRoot, { recursive: true })
const mode = process.argv[2]
function protect(value, decrypt = false) {
  const action = decrypt
    ? '[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($inputText),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))'
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); [Console]::Write(${action})`], { input:value, encoding:'utf8', windowsHide:true, stdio:['pipe','pipe','pipe'] })
}
let state = {}
try {
  const decoded=protect(await fs.readFile(secretFile,'utf8'),true)
  try { state=JSON.parse(decoded) } catch {
    // Recover ASCII credential fields from the first pre-UTF8 console write.
    // No route mutation occurred before this migration; refresh the catalogue.
    for(const name of ['site','apiKey','baseUrl','routingToken','routingTokenExpiresAt']) {
      const match=decoded.match(new RegExp('"'+name+'":"([^"\\r\\n]*)"'))
      if(match)state[name]=match[1]
    }
    if(state.site!==site||!state.apiKey||!state.routingToken)throw new Error('Credential recovery failed')
  }
} catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot decrypt test probe session (${e.name}; process status ${e.status ?? 'none'})`) }
async function save() {
  const encrypted = protect(JSON.stringify(state).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')))
  await fs.writeFile(secretFile + '.tmp', encrypted, 'utf8')
  await fs.copyFile(secretFile + '.tmp', secretFile)
  if(await fs.readFile(secretFile,'utf8')!==encrypted)throw new Error('Encrypted session persistence failed')
}
function out(data) { console.log(JSON.stringify(data, null, 2)) }
async function api(endpoint, { method='GET', bearer, body } = {}) {
  const response = await fetch(endpoint, { method, redirect:'error', signal:AbortSignal.timeout(20000), headers:{ ...(bearer?{Authorization:`Bearer ${bearer}`} : {}), ...(body?{'Content-Type':'application/json'} : {}) }, ...(body?{body:JSON.stringify(body)} : {}) })
  let payload
  try { payload = await response.json() } catch { throw new Error(`Invalid JSON (HTTP ${response.status})`) }
  if (!response.ok || payload.success === false) {
    const err = new Error(`HTTP ${response.status}`)
    err.status=response.status
    err.retryAfter=response.headers.get('retry-after')
    let message=payload.message??(typeof payload.error==='string'?payload.error:payload.error?.message)
    if(typeof message==='string'){
      for(const secret of [state.apiKey,state.routingToken,state.originalApiKey])if(secret)message=message.split(secret).join('[redacted]')
      err.serverMessage=message.replace(/(?:sk-|mdr_)[A-Za-z0-9_-]+/g,'[redacted]').slice(0,500)
    }
    throw err
  }
  return payload
}
async function device(endpoint, opts) { const r=await api(site+endpoint,opts); if(r.success!==true||!r.data||typeof r.data!=='object')throw new Error('Invalid device envelope');return r.data }
function route(data) { return { account:data.account ?? data.provider, group:data.current ?? data.group ?? null } }
function same(a,b){return a?.account===b?.account&&String(a?.group??'')===String(b?.group??'')}
function publicGroups(data) {
  return { ...route(data), node:data.node, keyStatus:data.keyStatus, canSwitch:data.canSwitch, canSwitchProvider:data.canSwitchProvider, providers:(data.providers??[]).map(p=>({account:p.account,label:p.label,kind:p.kind,groups:(p.groups??[]).map(g=>({id:g.id,label:g.label}))})) }
}
function credentials(data) {
  if(typeof data.apiKey!=='string'||!data.apiKey||typeof data.baseUrl!=='string')throw new Error('Missing credentials')
  const url=new URL(data.baseUrl)
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Invalid credential endpoint')
  state.apiKey=data.apiKey;state.baseUrl=data.baseUrl;state.current=route(data)
  if(typeof data.username==='string')state.username=data.username
  if(typeof data.balanceCents==='string')state.balanceCents=data.balanceCents
  if(Array.isArray(data.models))state.freeModels=data.models;else delete state.freeModels
}
function requireToken(){if(!state.routingToken)throw new Error('Run session first')}
async function recover(){requireToken();const data=await device('/api/device/group?credentials=1',{bearer:state.routingToken});if(data.credentials)credentials(data.credentials);state.current=route(data);await save();return publicGroups(data)}

try {
  if(mode==='authorize') {
    if(state.apiKey)throw new Error('Existing authorized test session; do not replace it')
    const data=await device('/api/device/code',{method:'POST'})
    const url=new URL(data.authUrl)
    if(url.origin!==site||!data.code)throw new Error('Invalid authorization response')
    state={site,code:data.code,authUrl:url.href,expiresAt:new Date(Date.now()+Math.min(Number(data.expiresIn),600)*1000).toISOString()}
    await save();out({status:'authorization-required',authUrl:url.href,expiresAt:state.expiresAt})
  } else if(mode==='poll') {
    if(state.apiKey){out({status:'connected'});process.exit(0)}
    if(!state.code)throw new Error('Run authorize first')
    const data=await device('/api/device/poll',{method:'POST',body:{code:state.code}})
    if(data.status==='ok'){credentials(data);delete state.code;await save();out({status:'connected'})}else out({status:data.status})
  } else if(mode==='session') {
    if(!state.apiKey)throw new Error('Complete test-account authorization first')
    const data=await device('/api/device/session',{method:'POST',bearer:state.apiKey})
    if(!data.routingToken)throw new Error('Missing independent routing token')
    state.routingToken=data.routingToken;state.routingTokenExpiresAt=data.routingTokenExpiresAt;await save();out({status:'routing-session-saved'})
  } else if(mode==='groups') {
    if(!state.apiKey&&!state.routingToken)throw new Error('Complete test-account authorization first')
    const data=await device('/api/device/group',{bearer:state.routingToken??state.apiKey})
    state.current=route(data);if(!state.hasSwitched){state.original=route(data);state.originalApiKey=state.apiKey}state.providers=publicGroups(data).providers;await save()
    await fs.writeFile(path.join(reportRoot,'providers.json'),JSON.stringify({checkedAt:new Date().toISOString(),...publicGroups(data)},null,2));out({...publicGroups(data),probeOriginal:state.original})
  } else if(mode==='switch'||mode==='restore') {
    requireToken()
    const target=mode==='restore'?state.original:{account:process.argv[3],group:process.argv[4]??null}
    if(!target?.account)throw new Error('Missing target account')
    if(target.account==='primary')throw new Error('Supplier 1 is deprecated and excluded by user request')
    const provider=state.providers?.find(p=>p.account===target.account)
    if(!provider)throw new Error('Read provider catalogue first')
    if(target.group&&!provider.groups.some(g=>String(g.id)===String(target.group)))throw new Error('Unknown group')
    const before=route(await device('/api/device/group',{bearer:state.routingToken}))
    if(!same(before,state.current))throw new Error('Remote route changed outside probe; stop without overwriting it')
    const data=await device('/api/device/group',{method:'POST',bearer:state.routingToken,body:{account:target.account,...(target.group?{group:target.group}:{}),expectedAccount:before.account,expectedGroup:before.group}})
    credentials(data);state.hasSwitched=true;await save();out({status:'switched',...route(data),keyStatus:data.keyStatus})
  } else if(mode==='recover') {
    out(await recover())
  } else if(mode==='close-session') {
    requireToken()
    const data=await device('/api/device/session',{method:'DELETE',bearer:state.routingToken})
    if(data.revoked!==true)throw new Error('Session revocation unconfirmed')
    delete state.routingToken;await save();out({status:'probe-session-revoked',modelKeyUnchanged:true})
  } else if(mode==='sync-client') {
    if(!same(state.current,state.original))throw new Error('Restore the original route first')
    if(!state.originalApiKey||!state.apiKey)throw new Error('Missing account-matching credentials')
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    try {
      const result=execFileSync(fileURLToPath(new URL('../../node_modules/electron/dist/electron.exe',import.meta.url)),[path.join(import.meta.dirname,'sync-probe-client.cjs')],{input:JSON.stringify({originalApiKey:state.originalApiKey,apiKey:state.apiKey,baseUrl:state.baseUrl,balanceCents:state.balanceCents}),encoding:'utf8',windowsHide:true,env,timeout:20000,stdio:['pipe','pipe','pipe']})
      console.log(result.trim())
    }catch(e){
      const lines=String(e.stdout??'').trim().split(/\r?\n/);let result
      try{result=JSON.parse(lines.at(-1))}catch{}
      if(result?.status==='failed')throw new Error('Client sync: '+result.reason)
      let diagnostic=String(e.stderr??'').slice(-1500)
      for(const secret of [state.apiKey,state.originalApiKey,state.routingToken])if(secret)diagnostic=diagnostic.split(secret).join('[redacted]')
      throw new Error('Client sync helper failed: '+diagnostic)
    }
  } else if(mode==='models') {
    if(!state.apiKey||!state.baseUrl)throw new Error('Complete test-account authorization first')
    const base=state.baseUrl.replace(/\/$/,'');const v1=/\/v1$/i.test(base)?base:base+'/v1'
    let payload,endpoint
    for(const suffix of ['/models','/model']){endpoint=v1+suffix;try{payload=await api(endpoint,{bearer:state.apiKey});break}catch(e){if(e.status===404&&suffix==='/models')continue;throw e}}
    const arr=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.models)?payload.models:null
    if(!arr)throw new Error('Unrecognized model-list response')
    const ids=[...new Set(arr.map(x=>typeof x==='string'?x:x?.id??x?.model??x?.name).filter(x=>typeof x==='string'&&x.trim()))].sort()
    const report={checkedAt:new Date().toISOString(),...state.current,endpoint,modelCount:ids.length,modelIds:ids}
    const filename=(state.current?.account+'--'+(state.current?.group??'default')).replace(/[^a-z0-9._-]/gi,'_')+'.json'
    await fs.writeFile(path.join(reportRoot,filename),JSON.stringify(report,null,2));out(report)
  } else throw new Error('Use authorize | poll | session | groups | switch <account> [group] | models | recover | restore')
} catch(error) {
  out({status:'failed',reason:error.message,statusCode:error.status,retryAfter:error.retryAfter,serverMessage:error.serverMessage})
  process.exitCode=1
}
