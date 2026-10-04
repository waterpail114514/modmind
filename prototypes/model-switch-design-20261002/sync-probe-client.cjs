// Windowless helper using the same Electron safeStorage format as ModMind.
const {app,safeStorage}=require('electron')
const fs=require('node:fs/promises')
const path=require('node:path')
const root=path.join(process.env.LOCALAPPDATA,'ModMindRoutingProbe','20261002')
require('node:fs').mkdirSync(path.join(root,'client-crypto'),{recursive:true})
app.setName('ModMind Routing Probe Crypto')
app.setPath('userData',path.join(root,'client-crypto'))
;(async()=>{
  try{
    await app.whenReady()
    const encrypted=await fs.readFile(path.join(root,'session.dpapi'),'utf8')
    const decoded=require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'],{input:encrypted,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']})
    const data=JSON.parse(decoded)
    if(!safeStorage.isEncryptionAvailable())throw new Error('System encryption unavailable')
    const file=path.join(process.env.APPDATA,'modmind','device-credentials.json')
    let original
    try{original=await fs.readFile(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
    if(!original&&(!data.username||!data.balanceCents||!data.site))throw new Error('Missing recovery identity')
    const stored=original?JSON.parse(original):{version:1,siteUrl:data.site,username:data.username,balanceCents:data.balanceCents,connectedAt:new Date().toISOString()}
    const oldKey=original?safeStorage.decryptString(Buffer.from(stored.encryptedApiKey,'base64')):data.originalApiKey
    if(oldKey!==data.originalApiKey&&oldKey!==data.apiKey){console.log(JSON.stringify({status:'unchanged-different-account'}));app.exit(0);return}
    if(original&&oldKey===data.apiKey&&stored.baseUrl===data.baseUrl){console.log(JSON.stringify({status:'already-current'}));app.exit(0);return}
    if(original)await fs.writeFile(path.join(root,'client-before-sync.json'),original,'utf8')
    const next={...stored,baseUrl:data.baseUrl,encryptedApiKey:safeStorage.encryptString(data.apiKey).toString('base64'),...(data.balanceCents?{balanceCents:data.balanceCents}:{})}
    delete next.usage
    const encoded=JSON.stringify(next,null,2)
    let current
    try{current=await fs.readFile(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
    if(current!==original)throw new Error('Client credentials changed concurrently')
    const temp=path.join(root,'client-after-sync.json')
    await fs.writeFile(temp,encoded,'utf8')
    await fs.mkdir(path.dirname(file),{recursive:true})
    await fs.writeFile(file,encoded,'utf8')
    const check=JSON.parse(await fs.readFile(file,'utf8'))
    if(safeStorage.decryptString(Buffer.from(check.encryptedApiKey,'base64'))!==data.apiKey)throw new Error('Credential verification failed')
    console.log(JSON.stringify({status:'client-credentials-synced'}));app.exit(0)
  }catch(e){console.log(JSON.stringify({status:'failed',reason:e.message}));app.exit(1)}
})()
