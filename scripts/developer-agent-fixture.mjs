import { promises as fs } from 'node:fs'
import path from 'node:path'

// Deterministic app-server fixture: no model service or credentials. All MCP
// discovery, edits, builds, debug calls, screenshots and exports use the real host.
export async function createDeveloperAgent(directory) {
  await fs.mkdir(directory, { recursive: true })
  const runner = path.join(directory, 'agent.mjs')
  const audit = path.join(directory, 'calls.jsonl')
  await fs.writeFile(runner, `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
const audit=${JSON.stringify(audit)};
if(process.argv.includes('--version')){console.log('codex-cli 0.100.0');process.exit(0)}
const arg=process.argv.find(value=>value.startsWith('mcp_servers.modmind.args='));
if(!arg)throw Error('Missing real MCP configuration');
const server=JSON.parse(arg.slice('mcp_servers.modmind.args='.length));
const child=spawn(${JSON.stringify(process.execPath)},server,{stdio:['pipe','pipe','ignore']});
let seq=0;const pending=new Map();
createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id)});
function rpc(method,params={}){return new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n')})}
const ready=rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'dev-agent-fixture',version:'1'}});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
async function call(name,args={}){const r=await rpc('tools/call',{name,arguments:args});fs.appendFileSync(audit,JSON.stringify({name,isError:r.result?.isError===true})+'\\n');if(r.error||r.result?.isError)throw Error(JSON.stringify(r));return JSON.parse(r.result.content[0].text)}
createInterface({input:process.stdin}).on('line',line=>{void(async()=>{
 const r=JSON.parse(line);if(!r.id)return;
 if(r.method==='initialize')send({id:r.id,result:{userAgent:'developer-fixture'}});
 else if(['thread/start','thread/resume'].includes(r.method))send({id:r.id,result:{thread:{id:'developer-fixture-thread'}}});
 else if(r.method==='mcpServerStatus/list'){await ready;const list=await rpc('tools/list');send({id:r.id,result:{data:[{name:'modmind',runtimeStatus:'connected',tools:list.result.tools}],nextCursor:null}})}
 else if(r.method==='mcpServer/tool/call'){const value=await rpc('tools/call',{name:r.params.tool,arguments:r.params.arguments||{}});send({id:r.id,result:value.result})}
 else if(r.method==='model/list')send({id:r.id,result:{data:[{id:'test-model',model:'test-model',displayName:'Test model'}],nextCursor:null}});
 else if(r.method==='turn/start'){
  send({id:r.id,result:{turn:{id:'developer-fixture-turn'}}});
  await call('modmind_mcp_probe');
  const info=await call('modmind_dev_read',{operation:'info'});
  const mainPath=info.project.sourceMode==='package'?'main.cjs':'main.ts';
  await call('modmind_dev_build');
  const before=await call('modmind_dev_debug',{operation:'tool',name:info.manifest.tools[0].name,input:{text:'你好'}});
  const source=await call('modmind_dev_read',{operation:'read',path:mainPath});
  let content=source.content,next=source.nextOffset;
  while(next!==null){const part=await call('modmind_dev_read',{operation:'read',path:mainPath,offset:next});if(part.revision!==source.revision)throw Error('Source changed while reading');content+=part.content;next=part.nextOffset}
  await call('modmind_dev_write',{path:mainPath,content:content.replace('Array.from(text).length','Array.from(text).length + 2'),revision:source.revision});
  await call('modmind_dev_build');
  const result=await call('modmind_dev_debug',{operation:'tool',name:info.manifest.tools[0].name,input:{text:'你好'}});
  if(result.result.characters!==before.result.characters+2)throw Error('MCP result mismatch');
  await call('modmind_dev_preview',{dark:false});
  await call('modmind_dev_export');
  send({method:'item/completed',params:{threadId:'developer-fixture-thread',turnId:'developer-fixture-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'开发闭环验证完成：已修改源码、构建、调用 MCP、检查界面截图并准备导出包。'}}});
  send({method:'turn/completed',params:{threadId:'developer-fixture-thread',turn:{id:'developer-fixture-turn',status:'completed'}}});
 }else if(r.method==='turn/interrupt')send({id:r.id,result:{}});
 else send({id:r.id,result:{}});
})().catch(error=>{fs.appendFileSync(audit,String(error.stack)+'\\n');send({method:'turn/completed',params:{threadId:'developer-fixture-thread',turn:{id:'developer-fixture-turn',status:'failed',error:{message:error.message}}}})})});
process.stdin.on('end',()=>{child.kill();process.exit(0)});
`)
  const executable = process.platform === 'win32' ? path.join(directory, 'codex.cmd') : runner
  if (process.platform === 'win32') await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0agent.mjs" %*\r\n`)
  else { await fs.writeFile(runner, '#!/usr/bin/env node\n' + await fs.readFile(runner, 'utf8')); await fs.chmod(runner, 0o755) }
  return { executable, audit }
}
