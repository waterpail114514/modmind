import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
const server=createServer((_req,_res)=>{})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const executable = process.argv[2]
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ModMind Codex 升级 '))
await fs.writeFile(path.join(root, 'config.toml'), 'model="test-model"\nmodel_provider="thirdparty"\nmodel_reasoning_effort="high"\n[features]\nenable_request_compression=false\n[model_providers.thirdparty]\nname="Third-party AI"\nbase_url="http://127.0.0.1:1/v1"\nenv_key="MODMIND_THIRD_PARTY_API_KEY"\nwire_api="responses"\nrequires_openai_auth=false\n')
await fs.writeFile(path.join(root, 'config.toml'), (await fs.readFile(path.join(root, 'config.toml'), 'utf8')).replace(':1/v1', ':'+server.address().port+'/v1'))
const child = spawn(executable, ['-s','workspace-write','-a','on-request','-c','approvals_reviewer="auto_review"','app-server','--listen','stdio://'], { env: {...process.env, CODEX_HOME:root, MODMIND_THIRD_PARTY_API_KEY:'local-test-only'}, windowsHide:true })
let seq=0, buffer='', stderr=''
const pending=new Map()
child.stderr.on('data', c=>stderr+=c)
child.stdout.on('data', c=>{buffer+=c; const lines=buffer.split('\n'); buffer=lines.pop(); for(const line of lines){if(!line.trim())continue;const msg=JSON.parse(line);if(msg.method==='error') console.error(JSON.stringify(msg)); if(pending.has(msg.id)){const {resolve,reject,timer}=pending.get(msg.id);clearTimeout(timer);pending.delete(msg.id);msg.error?reject(new Error(JSON.stringify(msg.error))):resolve(msg.result)}}})
function request(method,params){console.error('REQUEST '+method);return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
try {
 await request('initialize',{clientInfo:{name:'modmind',version:'test'},capabilities:{experimentalApi:true}})
 child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n')
 const common={cwd:root,model:'test-model',modelProvider:'thirdparty',approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'}
 for(const policy of [common,{...common,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only'},{...common,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'}]){
  const result=await request('thread/start',policy);assert.ok(result.thread.id)
  await request('thread/read',{threadId:result.thread.id,includeTurns:false})
  await new Promise(resolve=>setTimeout(resolve,300)); const turn=await request('turn/start',{threadId:result.thread.id,input:[{type:'text',text:'local protocol smoke',text_elements:[]}],model:'test-model',effort:'high'});assert.ok(turn.turn.id)
  await request('turn/interrupt',{threadId:result.thread.id,turnId:turn.turn.id}).catch(error=>{if(!error.message.includes('no active turn'))throw error})
  await new Promise(resolve=>setTimeout(resolve,500)); await request('thread/resume',{threadId:result.thread.id,...policy,excludeTurns:true})
  await request('thread/fork',{threadId:result.thread.id,...policy,excludeTurns:true})
 }
 console.log(JSON.stringify({ok:true,checks:['managed config','CLI approval arguments','initialize','thread/start: auto-review, read-only, yolo','thread/read','turn/start','turn/interrupt','thread/resume','thread/fork'],root,stderr},null,2))
} finally {server.closeAllConnections();server.close();child.stdin.end();setTimeout(()=>child.kill(),2000).unref()}
