import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { sameProjectPath } from './projectPath'
import type { ProjectInfo } from '../shared/types'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-disassociate-')); roots.push(root)
  const projectPath = path.join(root, 'instance')
  const files = ['mods/example.jar', 'config/example.toml', 'saves/world/level.dat', 'modmind.project.json', '.modmind/history.json', '.modmind/external-agents/bridge.json']
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(projectPath, file)), { recursive: true })
    await fs.writeFile(path.join(projectPath, file), file)
  }
  const project = { path: projectPath, name: 'Instance' } as ProjectInfo
  const other = { path: path.join(root, 'other'), name: 'Other' } as ProjectInfo
  const configFile = path.join(root, 'recent-projects.json')
  await fs.writeFile(configFile, JSON.stringify([project, other]))
  // Execute the application's actual business function; index.ts itself starts
  // Electron, so isolate this declaration and inject only its collaborators.
  const source = await fs.readFile(path.resolve('src/main/index.ts'), 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'removeProjectAssociation')!
  const context = {
    path, sameProjectPath, currentProject: project as ProjectInfo | null,
    assertProjectMutationAllowed: vi.fn(), assertProjectSwitchAllowed: vi.fn(),
    minecraftRuntime: { getState: () => ({ running: false }) },
    publicMcpBridge: {}, publicMcpBridgeProjectPath: projectPath,
    stopPublicMcpBridge: vi.fn(async (_preserveFiles: boolean) => {}),
    blockbenchBridge: { hide: vi.fn() }, emitProjectChanged: vi.fn(),
    readRecentProjects: async () => JSON.parse(await fs.readFile(configFile, 'utf8')) as ProjectInfo[],
    writeRecentProjects: vi.fn(async (projects: ProjectInfo[]) => { await fs.writeFile(configFile, JSON.stringify(projects)) })
  }
  Object.assign(context, { optionalTestingService: () => ({ minecraftRuntime: context.minecraftRuntime }) })
  const js = ts.transpile(declaration.getText(ast), { target: ts.ScriptTarget.ES2022 })
  const remove = vm.runInNewContext(`${js}; removeProjectAssociation`, context) as (projectPath: string) => Promise<ProjectInfo[]>
  const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(projectPath, file))).digest('hex') ])))
  return { root, project, other, context, remove, hashes }
}

it('removes only the association, persists it, closes the active context and preserves every instance file', async () => {
  const f = await fixture(), before = await f.hashes()
  expect(await f.remove(f.project.path)).toEqual([f.other])
  expect(await f.context.readRecentProjects()).toEqual([f.other])
  expect(await f.hashes()).toEqual(before)
  expect(f.context.currentProject).toBeNull()
  expect(f.context.stopPublicMcpBridge).toHaveBeenCalledWith(true)
  expect(f.context.emitProjectChanged).toHaveBeenCalledOnce()
})

it('keeps another active project and its bridge intact', async () => {
  const f = await fixture()
  f.context.currentProject = f.other; f.context.publicMcpBridgeProjectPath = f.other.path
  expect(await f.remove(f.project.path)).toEqual([f.other])
  expect(f.context.currentProject).toEqual(f.other)
  expect(f.context.stopPublicMcpBridge).not.toHaveBeenCalled()
  expect(f.context.emitProjectChanged).not.toHaveBeenCalled()
})

it('keeps the association when a running task, test or persistence error prevents removal', async () => {
  const f = await fixture(), before = await f.hashes()
  f.context.assertProjectMutationAllowed.mockImplementationOnce(() => { throw new Error('AI 任务正在运行') })
  await expect(f.remove(f.project.path)).rejects.toThrow('AI 任务')
  f.context.assertProjectSwitchAllowed.mockImplementationOnce(() => { throw new Error('测试正在运行') })
  await expect(f.remove(f.project.path)).rejects.toThrow('测试')
  f.context.writeRecentProjects.mockRejectedValueOnce(new Error('EACCES'))
  await expect(f.remove(f.project.path)).rejects.toThrow('EACCES')
  expect(await f.context.readRecentProjects()).toEqual([f.project, f.other])
  expect(f.context.currentProject).toEqual(f.project)
  expect(await f.hashes()).toEqual(before)
  await expect(f.remove('')).rejects.toThrow('项目路径无效')
})
