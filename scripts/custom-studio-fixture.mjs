import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export const definition = {
  apiVersion: 1, id: 'qa-shader-domain', name: '测试光影工作台', projectKind: 'shader', loaders: ['glsl'],
  defaultTarget: { loader: 'glsl', version: '1' }, templateHandler: 'shader',
  creation: { fields: [
    { id: 'project-title', title: '项目名称', type: 'input', bind: 'name', required: true, maxLength: 80 },
    { id: 'loader', title: '语言', type: 'options', bind: 'loader', default: 'glsl', options: [{ value: 'glsl', title: 'GLSL' }] },
    { id: 'version', title: '格式版本', type: 'input', bind: 'minecraftVersion', default: '1', required: true, maxLength: 80 },
    { id: 'lighting', title: '光照', type: 'options', default: 'day', options: [{ value: 'day', title: '日间' }, { value: 'night', title: '夜间' }] },
    { id: 'quality', title: '品质', type: 'select', default: 'balanced', options: [{ value: 'balanced', title: '均衡' }, { value: 'cinematic', title: '电影' }] }
  ] },
  adoption: { handler: 'shader', priority: 100, markers: ['shader-project.json'] },
  ai: {
    workbench: { instructions: 'QA shader engineering profile', skills: [], greetings: ['测试光影工程'], starters: [{ title: '调整光照', prompt: '调整光照效果' }] },
    inspiration: { instructions: 'QA shader inspiration profile; read only', skills: [], greetings: ['测试光影视觉方案'], starters: [{ title: '讨论光照', prompt: '讨论光照方案' }] }
  }
}
export async function customStudioFixture(directory, studio = definition, id = 'qa-shader-studio', marker = 'shader-project.json') {
  const main = `const fs=require('node:fs'),path=require('node:path');const studio=${JSON.stringify(studio)},marker=${JSON.stringify(marker)};exports.activate=()=>({studios:{[studio.templateHandler]:{
    templateFiles:project=>({[marker]:JSON.stringify({name:project.name,...project.studioValues})}),
    inspectExisting:async root=>fs.existsSync(path.join(root,marker))?{sourcePath:root,sourceName:path.basename(root),kind:'complete',fileCount:1,sourceFileCount:0,documentCount:0,detectedFiles:[marker],reasons:['识别为'+studio.name+'工程'],inferred:{name:path.basename(root),namespace:'custom_project',kind:studio.projectKind,loader:studio.defaultTarget.loader,minecraftVersion:studio.defaultTarget.version}}:null,
    adoptExisting:async()=>({mode:'in-place'})
  }}})`
  const renderer = `window.__modmindRegisterFeature(${JSON.stringify(id)},{apiVersion:2,pages:[]});`
  const files = new Map([['main.cjs', Buffer.from(main)], ['renderer.js', Buffer.from(renderer)], ['renderer.css', Buffer.from('')]])
  const manifest = { format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0', id, name: studio.name, version: '1.0.0', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', studios: [studio], files: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  await fs.mkdir(directory, { recursive: true })
  const archive = path.join(directory, `${id}.mmstudio`)
  await new Promise((resolve, reject) => {
    const zip = createRequire(import.meta.url)('archiver')('zip'), output = createWriteStream(archive)
    output.on('close', resolve); output.on('error', reject); zip.on('error', reject); zip.pipe(output)
    for (const [name, bytes] of files) zip.append(bytes, { name })
    void zip.finalize().catch(reject)
  })
  return archive
}
