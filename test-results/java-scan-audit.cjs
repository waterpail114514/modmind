const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), vm=require('node:vm'), ts=require('typescript'), assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
(async()=>{
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'modmind-java-scan-audit-')));
const pf=path.join(root,'Program Files'), px=path.join(root,'Program Files (x86)'), user=path.join(root,'user');
const homes={standard:path.join(pf,'Zulu','zulu-21'), nested:path.join(pf,'Zulu','vendor','zulu-17'), x86:path.join(px,'Zulu','zulu-8'), portable:path.join(root,'portable','zulu-21'), pathFirst:path.join(root,'path-first'), pathSecond:path.join(root,'path-second'), manual:path.join(root,'manual','zulu-17')};
for(const h of Object.values(homes)){await fs.mkdir(path.join(h,'bin'),{recursive:true});await fs.writeFile(path.join(h,'bin','java.exe'),'fixture');}
const calls=[];
function spawn(command,args){calls.push(command);const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();process.nextTick(()=>{c.stderr.emit('data',Buffer.from(command==='java.exe'?`    java.home = ${homes.pathFirst}\nopenjdk version "21.0.8"\n`:'openjdk version "21.0.8"\nOpenJDK Runtime Environment Zulu21\n'));c.emit('exit',0)});return c;}
const source=await fs.readFile('src/main/minecraftRuntime.ts','utf8');
const ast=ts.createSourceFile('runtime.ts',source,ts.ScriptTarget.Latest,true);
const names=['isNonEmptyFile','probeJavaHome','discoverJavaHomesFromPath','listSubdirectoryPaths','commonRootJavaHomeCandidates','detectInstalledJavaHomes'];
const extracted=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
const env={ProgramFiles:pf,'ProgramFiles(x86)':px,PATH:[path.join(homes.pathFirst,'bin'),path.join(homes.pathSecond,'bin')].join(path.delimiter)};
const ctx=vm.createContext({fs,path,os:{homedir:()=>user},process:{platform:'win32',env},app:{getPath:()=>path.join(root,'app')},spawn,setTimeout,clearTimeout,exists:async p=>fs.access(p).then(()=>true,()=>false),stopProcessTree:async()=>{}});
vm.runInContext(ts.transpileModule(extracted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
const detected=await ctx.detectInstalledJavaHomes();
const results=Object.entries(homes).map(([layout,home])=>({layout,detected:detected.some(x=>x.home===home)}));
assert.equal(results.find(x=>x.layout==='standard').detected,true);
assert.equal(results.find(x=>x.layout==='pathFirst').detected,true);
for(const k of ['portable','manual'])assert.equal(results.find(x=>x.layout===k).detected,false);
for(const k of ['nested','x86','pathSecond'])assert.equal(results.find(x=>x.layout===k).detected,true);
const saved=await ctx.detectInstalledJavaHomes([homes.manual]);assert.ok(saved.some(x=>x.home===homes.manual));
env.JAVA_HOME=homes.portable;
const second=await ctx.detectInstalledJavaHomes();assert.ok(second.some(x=>x.home===homes.portable));
console.log(JSON.stringify({method:'Actual scanner and probe functions, real isolated directory fixtures, simulated successful Java process output (not real JVM execution)',results,portableViaJavaHome:true,fixtureRoot:root},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
