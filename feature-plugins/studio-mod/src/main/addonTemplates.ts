import { createHash } from 'node:crypto'
import type { ProjectInfo } from '../../../../src/shared/types'
import { CURRENT_PROJECT_VERSION } from '../../../../src/main/projectVersion'
import { officialTemplateSources } from '../../../../src/main/loaderCompatibility'
import { projectLangValue } from '../../../../src/shared/projectName'

function uuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function engineVersion(version: string): number[] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  while (parts.length < 3) parts.push(0)
  return parts.slice(0, 3)
}

function manifestHeader(project: ProjectInfo, kind: string): Record<string, unknown> {
  return {
    name: `${project.name} ${kind}`,
    description: `Created with ModMind for ${project.loader}`,
    uuid: uuid(`${project.namespace}:${project.loader}:${kind}:header`),
    version: [0, 1, 0],
    min_engine_version: project.loader === 'bedrock' ? engineVersion(project.minecraftVersion) : [1, 21, 0]
  }
}

function projectMetadata(project: ProjectInfo): Record<string, string> {
  return {
    source: officialTemplateSources[project.loader],
    platform: project.loader,
    targetVersion: project.minecraftVersion,
    toolchainVersion: project.loaderVersion ?? '',
    projectVersion: CURRENT_PROJECT_VERSION,
    generatedAt: project.createdAt
  }
}

function standaloneAddonBuilder(namespace: string): string {
  return `import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const namespace = ${JSON.stringify(namespace)}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return (value ^ 0xffffffff) >>> 0
}

function zip(entries) {
  const local = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\\\', '/'))
    const checksum = crc32(entry.data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(entry.data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, entry.data)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(entry.data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(directory, name); offset += header.length + name.length + entry.data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

async function entries(directory, relative = '') {
  const result = []
  for (const child of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.isSymbolicLink()) continue
    const absolute = path.join(directory, child.name)
    const name = path.posix.join(relative, child.name)
    if (child.isDirectory()) result.push(...await entries(absolute, name))
    else if (child.isFile()) result.push({ name, data: await fs.readFile(absolute) })
  }
  return result
}

await fs.mkdir(path.join(root, 'behavior_pack', 'scripts'), { recursive: true })
await fs.copyFile(path.join(root, 'src', 'main.js'), path.join(root, 'behavior_pack', 'scripts', 'main.js'))
const output = path.join(root, 'build')
await fs.mkdir(output, { recursive: true })
const packs = []
for (const [directory, suffix] of [['behavior_pack', 'behavior'], ['resource_pack', 'resources']]) {
  const data = zip(await entries(path.join(root, directory)))
  const name = namespace + '-' + suffix + '.mcpack'
  await fs.writeFile(path.join(output, name), data)
  packs.push({ name, data })
}
const addon = path.join(output, namespace + '.mcaddon')
await fs.writeFile(addon, zip(packs))
console.log('Built ' + addon)
`
}

export function bedrockTemplateFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const behaviorHeader = manifestHeader(project, 'Behavior Pack')
  const resourceHeader = manifestHeader(project, 'Resource Pack')
  const apiVersion = project.apiVersion || '2.9.0'
  const mainScript = `import { system, world } from '@minecraft/server'\n\nsystem.run(() => {\n  world.sendMessage(${JSON.stringify(`[ModMind] ${project.name} loaded`)})\n})\n`
  const files: Record<string, string> = {
    'modmind.project.json': JSON.stringify({ ...project, projectVersion: CURRENT_PROJECT_VERSION }, null, 2),
    'modmind.template.json': JSON.stringify(projectMetadata(project), null, 2),
    'behavior_pack/manifest.json': JSON.stringify({
      format_version: 2,
      header: behaviorHeader,
      modules: [
        { type: 'data', uuid: uuid(`${project.namespace}:bedrock:behavior:data`), version: [0, 1, 0] },
        { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: uuid(`${project.namespace}:bedrock:behavior:script`), version: [0, 1, 0] }
      ],
      dependencies: [
        { uuid: resourceHeader.uuid, version: [0, 1, 0] },
        { module_name: '@minecraft/server', version: apiVersion }
      ]
    }, null, 2),
    'resource_pack/manifest.json': JSON.stringify({
      format_version: 2,
      header: resourceHeader,
      modules: [{ type: 'resources', uuid: uuid(`${project.namespace}:bedrock:resources:module`), version: [0, 1, 0] }]
    }, null, 2),
    'resource_pack/texts/languages.json': JSON.stringify(['en_US', 'zh_CN'], null, 2),
    'resource_pack/texts/en_US.lang': `pack.name=${projectLangValue(project.name)}\npack.description=Created with ModMind\n`,
    'resource_pack/texts/zh_CN.lang': `pack.name=${projectLangValue(project.name)}\npack.description=使用 ModMind 创建\n`,
    'src/main.js': mainScript,
    'behavior_pack/scripts/main.js': mainScript,
    'tools/build-addon.mjs': standaloneAddonBuilder(project.namespace),
    'package.json': JSON.stringify({
      name: project.namespace,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { build: 'node tools/build-addon.mjs', mcaddon: 'node tools/build-addon.mjs' },
      devDependencies: { '@minecraft/server': apiVersion }
    }, null, 2),
    'jsconfig.json': JSON.stringify({ compilerOptions: { checkJs: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src/**/*.js'] }, null, 2),
    '.gitignore': 'node_modules/\nbuild/\n.modmind/\n',
    '.gitattributes': '*.json text eol=lf\n*.js text eol=lf\n*.mcpack binary\n*.mcaddon binary\n',
    'README.md': `# ${project.name}\n\nInternational Bedrock Add-On, minimum engine ${project.minecraftVersion}, Script API ${apiVersion}.\n\nRun \`npm run build\` to validate and create \`build/${project.namespace}.mcaddon\`. Double-click the mcaddon file to import it into Minecraft Bedrock Edition.\n`
  }
  if (includeStarter) files['docs/idea.md'] = '# Add-On idea\n\nDescribe the gameplay, resources and mobile interaction requirements here.\n'
  return files
}

function neteaseModMain(project: ProjectInfo): string {
  const binding = project.namespace.replaceAll('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase()).replaceAll(' ', '')
  return `# -*- coding: utf-8 -*-
from mod.common.mod import Mod


@Mod.Binding(name=${JSON.stringify(binding)}, version="0.1.0")
class ${binding}(object):
    @Mod.InitServer()
    def server_init(self):
        import mod.server.extraServerApi as serverApi
        serverApi.RegisterSystem(${JSON.stringify(project.namespace)}, "ServerSystem", ${JSON.stringify(`${project.namespace}.serverSystem.ServerSystem`)})

    @Mod.DestroyServer()
    def server_destroy(self):
        pass

    @Mod.InitClient()
    def client_init(self):
        import mod.client.extraClientApi as clientApi
        clientApi.RegisterSystem(${JSON.stringify(project.namespace)}, "ClientSystem", ${JSON.stringify(`${project.namespace}.clientSystem.ClientSystem`)})

    @Mod.DestroyClient()
    def client_destroy(self):
        pass
`
}

export function neteaseTemplateFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const behaviorHeader = manifestHeader(project, 'Behavior Pack')
  const resourceHeader = manifestHeader(project, 'Resource Pack')
  const mobile = project.loader === 'netease-mobile'
  const files: Record<string, string> = {
    'modmind.project.json': JSON.stringify({ ...project, projectVersion: CURRENT_PROJECT_VERSION }, null, 2),
    'modmind.template.json': JSON.stringify(projectMetadata(project), null, 2),
    'netease.project.json': JSON.stringify({
      formatVersion: 1,
      name: project.name,
      namespace: project.namespace,
      target: mobile ? 'mobile' : 'pc',
      modSdkVersion: project.minecraftVersion,
      behaviorPack: 'behavior_pack',
      resourcePack: 'resource_pack'
    }, null, 2),
    'behavior_pack/manifest.json': JSON.stringify({
      format_version: 2,
      header: behaviorHeader,
      modules: [{ type: 'data', uuid: uuid(`${project.namespace}:${project.loader}:behavior:data`), version: [0, 1, 0] }],
      dependencies: [{ uuid: resourceHeader.uuid, version: [0, 1, 0] }]
    }, null, 2),
    'resource_pack/manifest.json': JSON.stringify({
      format_version: 2,
      header: resourceHeader,
      modules: [{ type: 'resources', uuid: uuid(`${project.namespace}:${project.loader}:resources:module`), version: [0, 1, 0] }]
    }, null, 2),
    'behavior_pack/modMain.py': neteaseModMain(project),
    [`behavior_pack/${project.namespace}/__init__.py`]: '',
    [`behavior_pack/${project.namespace}/serverSystem.py`]: `# -*- coding: utf-8 -*-\nimport mod.server.extraServerApi as serverApi\n\n\nclass ServerSystem(serverApi.GetServerSystemCls()):\n    def __init__(self, namespace, system_name):\n        serverApi.GetServerSystemCls().__init__(self, namespace, system_name)\n        print(${JSON.stringify(`[ModMind] ${project.name} server initialized`)})\n`,
    [`behavior_pack/${project.namespace}/clientSystem.py`]: `# -*- coding: utf-8 -*-\nimport mod.client.extraClientApi as clientApi\n\n\nclass ClientSystem(clientApi.GetClientSystemCls()):\n    def __init__(self, namespace, system_name):\n        clientApi.GetClientSystemCls().__init__(self, namespace, system_name)\n        print(${JSON.stringify(`[ModMind] ${project.name} client initialized`)})\n`,
    'resource_pack/texts/languages.json': JSON.stringify(['en_US', 'zh_CN'], null, 2),
    'resource_pack/texts/zh_CN.lang': `pack.name=${projectLangValue(project.name)}\npack.description=网易 Mod SDK ${mobile ? '手游' : 'PC'} 工程\n`,
    '.gitignore': 'build/\n.modmind/\n*.pyc\n__pycache__/\n',
    '.gitattributes': '*.json text eol=lf\n*.py text eol=lf\n',
    'README.md': `# ${project.name}\n\nNetEase Minecraft Mod SDK ${project.minecraftVersion} project targeting ${mobile ? 'mobile' : 'PC'}.\n\nImport this directory into the official NetEase developer workbench. Packaging, device testing, account verification and publishing must be completed in the official workbench.\n`
  }
  if (includeStarter) files['docs/idea.md'] = `# 网易模组构想\n\n目标：${mobile ? '手游' : 'PC'}\n\n记录玩法、双端通信、UI、性能与审核要求。\n`
  return files
}
