import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_BLOCKS = 250000
export const MAX_VOLUME = 8000000
const MAX_BYTES = 32 * 1024 * 1024

export function validateBuild(build) {
  if (!build || !Array.isArray(build.size) || build.size.length !== 3 ||
    build.size.some(n => !Number.isInteger(n) || n < 1 || n > 2048) || build.size.reduce((a,b) => a*b,1) > MAX_VOLUME) {
    throw new Error('建筑尺寸无效或超过 800 万格，请拆分建筑后重试')
  }
  if (!Array.isArray(build.palette) || build.palette.length > 20000 || !Array.isArray(build.blocks) || build.blocks.length > MAX_BLOCKS) throw new Error('建筑最多支持 25 万个方块、2 万种状态')
  for (const entry of build.palette) {
    if (!entry || typeof entry.Name !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(entry.Name)) throw new Error('方块 ID 无效')
    if (entry.Properties && (typeof entry.Properties !== 'object' || Object.entries(entry.Properties).some(([key,value]) => !/^[a-z0-9_]+$/.test(key) || typeof value !== 'string' || !/^[a-z0-9_.-]+$/.test(value)))) throw new Error('方块状态属性无效')
  }
  const occupied = new Set()
  for (const block of build.blocks) {
    if (!block || !Array.isArray(block.pos) || block.pos.length !== 3 || block.pos.some((n,i) => !Number.isInteger(n) || n < 0 || n >= build.size[i]) || !Number.isInteger(block.state) || !build.palette[block.state]) throw new Error('建筑含越界坐标或无效调色板引用')
    const key = block.pos.join(',')
    if (occupied.has(key)) throw new Error('建筑含重复坐标')
    occupied.add(key)
  }
  if (build.dataVersion != null && (!Number.isInteger(build.dataVersion) || build.dataVersion < 1)) throw new Error('建筑 DataVersion 无效')
  if (Buffer.byteLength(JSON.stringify(build)) > MAX_BYTES - 4096) throw new Error('建筑文件超过 32 MiB')
  return build
}

function fileAt(project, leaf = '') {
  if (!project || !path.isAbsolute(project)) throw new Error('请先打开项目')
  let target = fs.realpathSync(project)
  for (const part of ['structures', ...(leaf ? [leaf] : [])]) {
    if (/[\\/:\0]/.test(part) || part.includes('..')) throw new Error('建筑路径无效')
    target = path.join(target,part)
    let stat
    try { stat = fs.lstatSync(target) } catch(error) { if(error.code !== 'ENOENT') throw error }
    if(stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error('建筑存储路径包含链接，请使用当前项目内的普通目录与文件')
  }
  return target
}
function idOf(id) {
  if(typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('建筑 ID 无效')
  return id
}
function read(project,id) {
  const file = fileAt(project,idOf(id)+'.modmind.json')
  if(fs.statSync(file).size > MAX_BYTES) throw new Error('建筑文件超过 32 MiB')
  const doc = JSON.parse(fs.readFileSync(file,'utf8'))
  if(doc.schemaVersion !== 1 || doc.id !== id || !Number.isInteger(doc.revision)) throw new Error('建筑文档损坏，请从 .bak 恢复')
  validateBuild(doc.build)
  return doc
}
function summary(doc) { return {id:doc.id,name:doc.name,revision:doc.revision,at:doc.updatedAt,blocks:doc.build.blocks.length,bytes:Buffer.byteLength(JSON.stringify(doc.build))} }
function list(project) {
  const dir = fileAt(project)
  if(!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.modmind\.json$/.test(name)).map(name => {
    const id = name.slice(0,36)
    try { return summary(read(project,id)) }
    catch(error) { return {id,name:'无法读取的建筑',error:String(error.message),at:0,blocks:0,bytes:0} }
  }).sort((a,b) => b.at-a.at)
}
function write(project,doc,previous) {
  const file = fileAt(project,doc.id+'.modmind.json')
  fs.mkdirSync(fileAt(project),{recursive:true})
  const temporary = fileAt(project,doc.id+'.'+randomUUID()+'.tmp')
  const backup = fileAt(project,doc.id+'.modmind.json.bak')
  const bytes = JSON.stringify(doc)
  try {
    fs.writeFileSync(temporary,bytes,{flag:'wx'})
    if(previous) fs.writeFileSync(backup,JSON.stringify(previous))
    fs.renameSync(temporary,file)
    return {document:read(project,doc.id),items:list(project)}
  } finally { if(fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}

export function queryDocuments(input) {
  if(input.id) return {document:read(input.projectPath,input.id)}
  return {items:list(input.projectPath)}
}
export function changeDocument(input) {
  const project = input.projectPath
  const operation = input.operation || 'save'
  const previous = operation === 'create' ? null : read(project,input.id)
  if(previous && input.expectedRevision !== previous.revision) throw new Error('建筑已在其他窗口或工作台更新。请重新打开建筑后再保存；当前编辑仍保留在视口中')
  if(operation === 'delete') {
    const file = fileAt(project,idOf(input.id)+'.modmind.json')
    fs.renameSync(file,fileAt(project,input.id+'.deleted-'+Date.now()+'.json'))
    return {deleted:input.id,items:list(project)}
  }
  const build = validateBuild(input.build || previous?.build)
  const name = String(input.name || previous?.name || build.name || '未命名建筑').trim().slice(0,80)
  const document = {schemaVersion:1,id:previous?.id || randomUUID(),revision:(previous?.revision || 0)+1,name,updatedAt:Date.now(),build:{...build,name}}
  return write(project,document,previous)
}
