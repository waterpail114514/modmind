import { promises as fs } from 'node:fs'
import path from 'node:path'
import { modTemplateFiles as projectTemplateFiles } from '../feature-plugins/studio-mod/src/main/modTemplates'
import type { LoaderKind, ProjectInfo } from '../src/shared/types'

const [targetInput = 'matrix-project'] = process.argv.slice(2)
const loader = process.env.LOADER as LoaderKind
if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) throw new Error(`Unsupported LOADER: ${loader}`)
const target = path.resolve(targetInput)
const project: ProjectInfo = {
  name: `ModMind ${loader} fixture`,
  path: target,
  loader,
  minecraftVersion: process.env.MINECRAFT ?? '',
  loaderVersion: process.env.LOADER_VERSION ?? '',
  ...(process.env.API_VERSION ? { apiVersion: process.env.API_VERSION } : {}),
  ...(process.env.QSL_VERSION ? { qslVersion: process.env.QSL_VERSION } : {}),
  javaVersion: Number(process.env.JAVA_VERSION),
  namespace: `modmind_${loader}_fixture`,
  createdAt: new Date(0).toISOString(),
  toolDataDirectory: '.modmind'
}
if (!project.minecraftVersion || !project.loaderVersion || !Number.isInteger(project.javaVersion)) {
  throw new Error('MINECRAFT, LOADER_VERSION, and JAVA_VERSION are required')
}
await fs.rm(target, { recursive: true, force: true })
for (const [relative, content] of Object.entries(projectTemplateFiles(project))) {
  const file = path.join(target, ...relative.split('/'))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}
process.stdout.write(`${loader} ${project.minecraftVersion} fixture generated at ${target}\n`)
