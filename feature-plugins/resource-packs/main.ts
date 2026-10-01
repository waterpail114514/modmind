import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { NativeFeatureHost } from '../../src/main/index'
import type { ProjectInfo } from '../../src/shared/types'
import { nativeActions } from '../sdk/native'
import { registerResourcePackIpc } from './src/main/resourcePackIpc'
import * as resources from './src/main/resourcePackService'

export function activate(options: { host: NativeFeatureHost }) {
  const host = options.host
  const { actions, handle } = nativeActions(host)
  registerResourcePackIpc({
    project: host.requireProject, window: () => host.mainWindow!,
    busy: () => Boolean(host.runsForProject(host.requireProject().path).length),
    blockbench: () => host.featurePluginService.service<ReturnType<typeof import('../model-studio/main').activate>>('model-studio').requireBlockbench(),
    handle
  })
  const operation = async (project: ProjectInfo, input: Record<string, unknown>): Promise<unknown> => {
    const id = typeof input.id === 'string' ? input.id : ''
    switch (input.operation) {
      case 'list': return resources.listResourcePacks(project)
      case 'create': return resources.createResourcePack(project, { name: String(input.name ?? ''), description: String(input.description ?? ''), packFormat: Number(input.packFormat) })
      case 'validate': return resources.validateResourcePack(project, id)
      case 'deploy': return resources.deployResourcePack(project, id)
      case 'export': {
        const bytes = await resources.resourcePackArchive(project, id)
        const file = path.join(project.path, 'build', 'resource-packs', `${id}.zip`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, bytes)
        return { path: file, bytes: bytes.length }
      }
      default: throw new Error('不支持的资源包操作')
    }
  }
  actions.operation = input => operation(host.requireProject(), input)
  return { ...resources, actions, operation }
}
