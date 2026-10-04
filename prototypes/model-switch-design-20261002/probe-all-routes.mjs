import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const script=path.join(import.meta.dirname,'probe-routes.mjs')
const reports=path.join(import.meta.dirname,'route-probe')
function step(args){
  const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true,timeout:50000})
  let data
  try{data=JSON.parse(r.stdout)}catch{throw new Error('Probe process failed without structured output')}
  if(r.status!==0){const e=new Error(data.reason??'Probe failed');e.detail=data;throw e}
  return data
}
const groups=step(['groups'])
const initial=groups.probeOriginal??{account:groups.account,group:groups.group}
const same=(a,b)=>a.account===b.account&&String(a.group??'')===String(b.group??'')
const targets=groups.providers.filter(p=>p.account!=='primary').flatMap(p=>p.kind==='paid'?p.groups.map(g=>({account:p.account,group:g.id,label:g.label})): [{account:p.account,group:null,label:p.label}])
targets.sort((a,b)=>(a.account===initial.account?0:a.account==='primary'?1:2)-(b.account===initial.account?0:b.account==='primary'?1:2))
const results=[]
let stopped=false, restored=false
try{
  for(const target of targets){
    const filename=(target.account+'--'+(target.group??'default')).replace(/[^a-z0-9._-]/gi,'_')+'.json'
    let existing
    try{existing=JSON.parse(await fs.readFile(path.join(reports,filename),'utf8'))}catch{}
    if(existing&&same(existing,target)&&Array.isArray(existing.modelIds)){results.push({...target,status:'ok',count:existing.modelCount});continue}
    await new Promise(r=>setTimeout(r,4500))
    try{
      step(['switch',target.account,...(target.group?[target.group]:[])])
      const data=step(['models'])
      results.push({...target,status:'ok',count:data.modelCount})
      console.log(JSON.stringify({route:target.label,account:target.account,models:data.modelCount}))
    }catch(e){
      results.push({...target,status:'failed',reason:e.message})
      console.log(JSON.stringify({route:target.label,status:'failed',reason:e.message}))
      const recovered=step(['recover'])
      console.log(JSON.stringify({recoveredAccount:recovered.account,recoveredGroup:recovered.group,keyStatus:recovered.keyStatus}))
      stopped=true;break
    }
  }
}finally{
  await new Promise(r=>setTimeout(r,4500))
  try{const result=step(['restore']);restored=same(result,initial);console.log(JSON.stringify({restore:restored?'ok':'mismatch',account:result.account,group:result.group}))}catch(e){console.log(JSON.stringify({restore:'failed',reason:e.message}));stopped=true}
  await fs.writeFile(path.join(reports,'scan-summary.json'),JSON.stringify({checkedAt:new Date().toISOString(),initial,restored,stopped,results},null,2))
}
if(stopped)process.exitCode=1
