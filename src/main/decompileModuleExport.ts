import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DecompileProvenance } from '../shared/decompile'
import {
  DECOMPILE_ACKNOWLEDGEMENT_FILE,
  DECOMPILE_PROVENANCE_COPY,
  DECOMPILE_TERMS_FILE,
  DECOMPILE_TERMS_TITLE,
  DECOMPILE_TERMS_VERSION,
  type CreatedModuleFromDecompiled,
  type DecompileTermsPayload
} from '../shared/decompileModuleExport'

export {
  DECOMPILE_ACKNOWLEDGEMENT_FILE,
  DECOMPILE_PROVENANCE_COPY,
  DECOMPILE_TERMS_FILE,
  DECOMPILE_TERMS_TITLE,
  DECOMPILE_TERMS_VERSION
}

/**
 * "现成 JAR → ModMind 自制模组工程" conversion (受控反编译的导出动作).
 *
 * Legal posture: the decompiled output is a derived work of the original mod. ModMind
 * never claims ownership, never warrants that the output compiles or is legally usable,
 * and requires the user to acknowledge the terms below before any export happens. The
 * acknowledgement is persisted inside the generated module so provenance travels with
 * the sources.
 */

/** Payload returned by the decompile:getTerms IPC for the renderer's consent dialog. */
export type { DecompileTermsPayload, CreatedModuleFromDecompiled }

export const DECOMPILE_TERMS_SECTIONS: Array<{ heading: string; body: string[] }> = [
  {
    heading: '1. 反编译行为的性质',
    body: [
      '你即将把一个第三方 Minecraft 模组或服务端插件 JAR 的反编译结果复制为一个新的本地源码工程。反编译产物是对原始字节码的机器还原：不含原作者的注释、不含局部变量名、可能包含还原错误，并且几乎不可能直接编译通过。',
      '该产物在法律上通常被视为原作品的演绎件（derivative work）。它的著作权仍属于原作者；本功能不转移任何权利，也不授予任何新的许可。'
    ]
  },
  {
    heading: '2. 你的合规责任由你承担',
    body: [
      '是否允许反编译取决于原模组的许可证（License）或作者授权。ModMind 不会也不可能在你的本地环境中替你判断这一点。继续操作即表示你确认自己已经查看并有权依据原模组的许可证或授权进行此行为。',
      '常见限制包括但不限于：禁止分发反编译产物、禁止将衍生代码用于商业用途、要求署名或以相同许可证开源。如果你无法确认授权状态，请勿继续，或先联系原作者获得书面许可。'
    ]
  },
  {
    heading: '3. ModMind 的免责范围',
    body: [
      'ModMind 仅提供本地技术工具，"按现状"（AS-IS）生成反编译产物，不作任何明示或默示的保证，包括对可编译性、正确性、完整性、不侵权或特定用途适用性的保证。',
      '对于你因使用、修改、编译、发布反编译产物而引发的任何主张、索赔、诉讼或损失（包括著作权侵权指控），ModMind 及其开发者不承担任何责任。所有法律责任由你自行承担。',
      'ModMind 不代表你做出任何法律判断。工具内出现的任何提示（如混淆检测、许可证字段展示）都只是技术信息，不构成法律意见。'
    ]
  },
  {
    heading: '4. 产物隔离与防误发约束',
    body: [
      '生成的模块会被标记为"源自反编译"，其元数据随附来源哈希与本条款接受记录。请勿将该模块的产物直接作为你自己的作品发布。',
      '若你基于这些源码做出了自己的修改并将其发布，你独自负责确保发布行为符合原作品许可证（例如以兼容许可证开源、保留署名等）。'
    ]
  },
  {
    heading: '5. 接受方式',
    body: [
      '点击"我已阅读并同意"即表示你以电子形式签署本条款，接受记录（条款版本、时间、来源 JAR 哈希）会写入生成的模块目录中。',
      '本条款版本更新后，再次导出需要重新确认。'
    ]
  }
]

export function renderDecompileTerms(sourceFileName: string): string {
  const lines: string[] = [`# ${DECOMPILE_TERMS_TITLE}`, '', `> 来源 JAR：${sourceFileName} · 条款版本 ${DECOMPILE_TERMS_VERSION}`, '']
  for (const section of DECOMPILE_TERMS_SECTIONS) {
    lines.push(`## ${section.heading}`, '')
    for (const paragraph of section.body) lines.push(paragraph, '')
  }
  return lines.join('\n')
}

export interface DecompileTermsAcknowledgement {
  termsVersion: string
  acceptedAt: string
  sourceJarSha256: string
  sourceFileName: string
  /** Which surface triggered the export; AI-driven exports are recorded as such. */
  origin: 'user-workspace' | 'ai-action'
}

function validateModuleName(name: string): { name: string; namespace: string } {
  const trimmed = name.trim().slice(0, 120)
  if (!trimmed) throw new Error('模块名称不能为空')
  const namespace = trimmed.toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error('模块名称必须能转换为合法的命名空间（字母开头，仅小写字母/数字/下划线）')
  return { name: trimmed, namespace }
}

export interface CreateModuleFromDecompiledInput {
  packPath: string
  packModulesDirectory?: string
  jarName: string
  moduleName: string
  provenance: DecompileProvenance
  /** Absolute path of the cached decompiled `sources` directory. */
  sourcesDirectory: string
  acknowledgement: Omit<DecompileTermsAcknowledgement, 'termsVersion'>
}

export interface SeedProjectFromDecompiledInput {
  projectPath: string
  jarName: string
  provenance: DecompileProvenance
  /** Absolute path of the cached decompiled `sources` directory. */
  sourcesDirectory: string
  acknowledgement: Omit<DecompileTermsAcknowledgement, 'termsVersion'>
}

export interface SeedProjectFromDecompiledResult {
  fileCount: number
  termsFilePath: string
  acknowledgementPath: string
  provenanceCopyPath: string
}

/** Pure path computation so the module layout is unit-testable without touching disk. */
export function plannedModulePaths(packPath: string, moduleName: string): { name: string; namespace: string; relativePath: string; absolutePath: string } {
  const { name, namespace } = validateModuleName(moduleName)
  const relativePath = `modules/${namespace}`
  return { name, namespace, relativePath, absolutePath: path.join(packPath, ...relativePath.split('/')) }
}

async function copyTree(sourceRoot: string, targetRoot: string, include: (fileName: string) => boolean = () => true): Promise<number> {
  let count = 0
  const queue: Array<[string, string]> = [[sourceRoot, targetRoot]]
  while (queue.length) {
    const [from, to] = queue.shift()!
    await fs.mkdir(to, { recursive: true })
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const sourceEntry = path.join(from, entry.name)
      const targetEntry = path.join(to, entry.name)
      if (entry.isDirectory()) queue.push([sourceEntry, targetEntry])
      else if (entry.isFile() && include(entry.name)) {
        await fs.copyFile(sourceEntry, targetEntry)
        count += 1
      }
    }
  }
  return count
}

/**
 * Creates `<pack>/modules/<namespace>` seeded with the cached decompiled sources plus
 * terms/provenance/acknowledgement records. Refuses when the terms version does not match
 * the current build or when the acknowledgement payload is incomplete.
 */
export async function createModuleFromDecompiledSources(input: CreateModuleFromDecompiledInput): Promise<CreatedModuleFromDecompiled> {
  if (input.provenance.plugin) throw new Error('服务端插件不能作为整合包的自制模组导入，请创建服务端插件项目')
  if (!input.provenance?.readOnly || input.provenance.schemaVersion !== 1) throw new Error('反编译缓存记录无效，请重新执行反编译')
  const acknowledgement: DecompileTermsAcknowledgement = {
    ...input.acknowledgement,
    termsVersion: DECOMPILE_TERMS_VERSION
  }
  if (acknowledgement.acceptedAt && new Date(acknowledgement.acceptedAt).toString() === 'Invalid Date') throw new Error('条款接受时间无效')
  const plan = plannedModulePaths(input.packPath, input.moduleName)
  if (await fs.stat(plan.absolutePath).then(() => true).catch(() => false)) throw new Error(`同名自制模组已存在：${plan.relativePath}`)
  const stat = await fs.stat(input.sourcesDirectory).catch(() => null)
  if (!stat?.isDirectory()) throw new Error('反编译缓存不存在，请先完成反编译')
  try {
    const copied = await copyTree(input.sourcesDirectory, plan.absolutePath)
    if (!copied) throw new Error('反编译结果为空，无法创建工程')
    await fs.mkdir(path.join(plan.absolutePath, 'docs'), { recursive: true })
    await fs.mkdir(path.join(plan.absolutePath, '.modmind'), { recursive: true })
    const termsFilePath = path.join(plan.absolutePath, ...DECOMPILE_TERMS_FILE.split('/'))
    const acknowledgementPath = path.join(plan.absolutePath, ...DECOMPILE_ACKNOWLEDGEMENT_FILE.split('/'))
    const provenanceCopyPath = path.join(plan.absolutePath, ...DECOMPILE_PROVENANCE_COPY.split('/'))
    await fs.writeFile(termsFilePath, renderDecompileTerms(input.jarName), 'utf8')
    await fs.writeFile(acknowledgementPath, `${JSON.stringify(acknowledgement, null, 2)}\n`, 'utf8')
    await fs.writeFile(provenanceCopyPath, `${JSON.stringify({ ...input.provenance, exportedToModule: plan.relativePath }, null, 2)}\n`, 'utf8')
    await fs.writeFile(path.join(plan.absolutePath, 'README.md'), [
      `# ${plan.name}`,
      '',
      `本模块由第三方模组 \`${input.jarName}\` 的受控反编译结果生成（sha256: ${input.provenance.sourceSha256.slice(0, 16)}…）。`,
      '',
      '- `docs/decompiled-sources-terms.md`：使用条款与免责声明（含你的接受记录位置）',
      '- `docs/decompiled-source-provenance.json`：来源哈希、反编译引擎与时间',
      '- `.modmind/decompile-terms-acknowledgement.json`：条款接受记录',
      '',
      '注意：反编译产物通常无法直接编译通过，也不会自动继承原作者的权利。发布前请阅读条款文件。'
    ].join('\n') + '\n', 'utf8')
    return {
      name: plan.name,
      namespace: plan.namespace,
      relativePath: plan.relativePath,
      fileCount: copied,
      termsFilePath,
      acknowledgementPath,
      provenanceCopyPath
    }
  } catch (error) {
    await fs.rm(plan.absolutePath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Seeds a standard standalone ModMind project with the cached decompiled Java sources. */
export async function seedProjectFromDecompiledSources(input: SeedProjectFromDecompiledInput): Promise<SeedProjectFromDecompiledResult> {
  if (!input.provenance?.readOnly || input.provenance.schemaVersion !== 1) throw new Error('反编译缓存记录无效，请重新执行反编译')
  const acknowledgement: DecompileTermsAcknowledgement = {
    ...input.acknowledgement,
    termsVersion: DECOMPILE_TERMS_VERSION
  }
  if (acknowledgement.acceptedAt && new Date(acknowledgement.acceptedAt).toString() === 'Invalid Date') throw new Error('条款接受时间无效')
  const projectRoot = path.resolve(input.projectPath)
  const sourceRoot = path.join(projectRoot, 'src', 'main', 'java')
  const copied = await copyTree(input.sourcesDirectory, sourceRoot, (fileName) => fileName.endsWith('.java'))
  if (!copied) throw new Error('反编译结果为空，无法创建项目')
  await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true })
  await fs.mkdir(path.join(projectRoot, '.modmind'), { recursive: true })
  const termsFilePath = path.join(projectRoot, ...DECOMPILE_TERMS_FILE.split('/'))
  const acknowledgementPath = path.join(projectRoot, ...DECOMPILE_ACKNOWLEDGEMENT_FILE.split('/'))
  const provenanceCopyPath = path.join(projectRoot, ...DECOMPILE_PROVENANCE_COPY.split('/'))
  await fs.writeFile(termsFilePath, renderDecompileTerms(input.jarName), 'utf8')
  await fs.writeFile(acknowledgementPath, `${JSON.stringify(acknowledgement, null, 2)}\n`, 'utf8')
  await fs.writeFile(provenanceCopyPath, `${JSON.stringify({ ...input.provenance, exportedToProject: true }, null, 2)}\n`, 'utf8')
  const readmePath = path.join(projectRoot, 'README.md')
  const readme = await fs.readFile(readmePath, 'utf8').catch(() => '')
  await fs.writeFile(readmePath, `${readme.trimEnd()}\n\n注意：src/main/java 中的源码来自第三方 JAR ${input.jarName} 的受控反编译结果。请先阅读 docs/decompiled-sources-terms.md，并在发布前确认许可证与署名要求。\n`, 'utf8')
  return { fileCount: copied, termsFilePath, acknowledgementPath, provenanceCopyPath }
}
