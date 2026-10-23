import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createStoredZip } from '../../../../src/main/bedrockAddon'
import { archiveEntries, archiveRead } from '../../../../src/main/archiveInspection'
import type { ProjectInfo } from '../../../../src/shared/types'
import { shaderTemplateFiles } from './shaderTemplates'
import * as service from './shaderService'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-shader-test-')); roots.push(root)
  const project: ProjectInfo = { name: 'Shader test', path: root, studioId: 'minecraft-shader', studioName: '光影工作台', kind: 'shader', loader: 'iris', minecraftVersion: '1.21.1', namespace: 'shader_test', createdAt: '' }
  for (const [file, content] of Object.entries(shaderTemplateFiles(project))) { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content) }
  return { root, project }
}
describe('Iris shader authoring service', () => {
  it('recognizes the independent source format, checks real GLSL, parses options and exports only shader delivery files', async () => {
    const { root, project } = await fixture()
    const source = await service.inspectShaderSource(root)
    expect(source?.inferred.studioId).toBe('minecraft-shader')
    const inventory = await service.shaderInventory(project)
    expect(inventory.programs).toHaveLength(3)
    expect(inventory.options.map(option => option.name)).toEqual(['EXPOSURE', 'SATURATION', 'CONTRAST'])
    expect(inventory.profiles.VIVID).toMatchObject({ SATURATION: '1.2' })
    const validated = await service.validateShader(project)
    expect(validated, JSON.stringify(validated)).toMatchObject({ status: 'syntax-checked', parsed: 6, skipped: 0, gameVerified: false, issues: [] })
    await fs.mkdir(path.join(root, '.modmind')); await fs.writeFile(path.join(root, '.modmind', 'private.json'), 'secret')
    await fs.writeFile(path.join(root, 'modmind.project.json'), JSON.stringify(project))
    const artifact = await service.exportShader(project), entries = await archiveEntries(artifact.path)
    expect(artifact.status).toBe('exported'); expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(entries).toContain('shaders/final.fsh'); expect(entries).not.toContain('modmind.project.json')
    expect(entries.some(file => file.startsWith('.modmind'))).toBe(false)
    expect((await archiveRead(artifact.path, 'shaders/final.fsh')).toString()).toContain('EXPOSURE')
  })
  it('updates actual include options, rejects stale revisions and invalid values, and undoes without losing unrelated files', async () => {
    const { project } = await fixture(), initial = await service.shaderInventory(project)
    const updated = await service.setShaderOptions(project, initial.revision, { EXPOSURE: '1.5', SATURATION: '1.2' })
    expect(updated.options.find(option => option.name === 'EXPOSURE')?.value).toBe('1.5')
    expect((await service.readShaderFile(project, 'shaders/lib/options.glsl')).content).toContain('#define EXPOSURE 1.5')
    await expect(service.setShaderOptions(project, initial.revision, { EXPOSURE: '1.0' })).rejects.toThrow('已变化')
    await expect(service.setShaderOptions(project, updated.revision, { EXPOSURE: '9.0' })).rejects.toThrow('选项值无效')
    await service.undoShaderChange(project)
    expect((await service.shaderInventory(project)).revision).toBe(initial.revision)
    const document = await service.readShaderFile(project, 'shaders/final.fsh')
    await service.saveShaderFile(project, document.path, document.content + '\n// change', document.revision)
    await expect(service.saveShaderFile(project, document.path, document.content, document.revision)).rejects.toThrow('已变化')
    await fs.appendFile(path.join(project.path, document.path), '\n// later external change')
    await expect(service.undoShaderChange(project)).rejects.toThrow('后续编辑')
  })
  it('detects include cycles, missing files, invalid GLSL and program stages without claiming game compilation', async () => {
    const { project } = await fixture()
    await fs.writeFile(path.join(project.path, 'shaders/lib/options.glsl'), '#include "options.glsl"')
    expect((await service.validateShader(project)).issues.some(issue => issue.message.includes('循环'))).toBe(true)
    await fs.writeFile(path.join(project.path, 'shaders/lib/options.glsl'), '#include "missing.glsl"')
    expect((await service.validateShader(project)).status).toBe('failed')
    await fs.writeFile(path.join(project.path, 'shaders/lib/options.glsl'), '#define X 1.0')
    await fs.writeFile(path.join(project.path, 'shaders/final.fsh'), '#version 120\nvoid main(){vec3 c = ;}')
    const failed = await service.validateShader(project)
    expect(failed.status).toBe('failed'); expect(failed.gameVerified).toBe(false)
    await expect(service.exportShader(project)).rejects.toThrow('检查未通过')
    await fs.writeFile(path.join(project.path, 'shaders/final.fsh'), '#version 120\nvoid main(){gl_FragColor=vec4(1.0);}')
    await fs.writeFile(path.join(project.path, 'shaders/compute.csh'), '#version 430\nvoid main(){}')
    const unsupported = await service.validateShader(project)
    expect(unsupported.skipped).toBe(1)
    expect(unsupported.issues.some(issue => issue.message.includes('计算阶段'))).toBe(true)
  })
  it('atomically saves const, toggle and profile program changes with CRLF preservation and shared undo', async () => {
    const { root, project } = await fixture()
    const options = '#ifndef GUARD\r\n#define GUARD\r\n#define TAA\r\nconst int shadowMapResolution = 3072; // [1024 3072 4096]\r\n#ifdef TAA\r\n#endif\r\n#endif\r\n'
    const properties = 'screen=TAA shadowMapResolution\r\nprofile.QUALITY=TAA shadowMapResolution=4096 !program.final\r\nprogram.final.enabled=TAA\r\n'
    await fs.writeFile(path.join(root, 'shaders/lib/options.glsl'), options)
    await fs.writeFile(path.join(root, 'shaders/shaders.properties'), properties)
    const inventory = await service.shaderInventory(project)
    const changed = await service.setShaderOptions(project, inventory.revision, { shadowMapResolution: '4096', TAA: 'false' }, inventory.profilePrograms.QUALITY)
    expect((await service.readShaderFile(project, 'shaders/lib/options.glsl')).content).toBe(options.replace('#define TAA', '// #define TAA').replace('= 3072;', '= 4096;'))
    expect((await service.readShaderFile(project, 'shaders/shaders.properties')).content).toBe(properties.replace('program.final.enabled=TAA', 'program.final.enabled=false'))
    expect(changed.programConditions.final).toBe('false')
    await expect(service.setShaderOptions(project, changed.revision, {}, { '../../escape': false })).rejects.toThrow('程序开关无效')
    await expect(service.setShaderOptions(project, changed.revision, { GUARD: 'false' })).rejects.toThrow('选项值无效')
    await service.undoShaderChange(project)
    expect((await service.readShaderFile(project, 'shaders/lib/options.glsl')).content).toBe(options)
    expect((await service.readShaderFile(project, 'shaders/shaders.properties')).content).toBe(properties)
    expect((await service.shaderInventory(project)).revision).toBe(inventory.revision)
  })
  it('rejects conditional and ambiguous program directives before writing any option file', async () => {
    const { root, project } = await fixture()
    const original = await service.readShaderFile(project, 'shaders/lib/options.glsl')
    for (const config of ['#if TAA\nprogram.final.enabled=true\n#endif\n', 'program.final.enabled=true\nprogram.final.enabled=false\n', 'program.final.enabled=\\\n true\n']) {
      await fs.writeFile(path.join(root, 'shaders/shaders.properties'), config)
      const inventory = await service.shaderInventory(project)
      await expect(service.setShaderOptions(project, inventory.revision, { EXPOSURE: '1.5' }, { final: false })).rejects.toThrow()
      expect((await service.readShaderFile(project, original.path)).content).toBe(original.content)
      expect((await service.readShaderFile(project, 'shaders/shaders.properties')).content).toBe(config)
    }
  })
  it('rejects unsafe reads, writes, symlink source roots and unrelated domains', async () => {
    const { root, project } = await fixture()
    await expect(service.readShaderFile(project, '../escape.fsh')).rejects.toThrow()
    await expect(service.readShaderFile(project, 'shaders/../../secret.fsh')).rejects.toThrow()
    await expect(service.shaderInventory({ ...project, kind: 'mod' })).rejects.toThrow('Iris')
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-shader-external-')); roots.push(external)
    await fs.symlink(external, path.join(root, 'shaders', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.shaderInventory(project)).rejects.toThrow('链接')
    await expect(service.inspectShaderSource(root)).rejects.toThrow('链接')
  })
  it('lets runtime testing package desktop GLSL after structure checks without claiming syntax success', async () => {
    const { root, project } = await fixture()
    await fs.writeFile(path.join(root, 'shaders/final.fsh'), '#version 430\nvoid main(){desktop_syntax_for_runtime(;}')
    expect((await service.validateShader(project)).status).toBe('failed')
    const artifact = await service.exportShader(project, true)
    expect(artifact.validation).toMatchObject({ status: 'structure-checked', parsed: 0, gameVerified: false })
    await fs.writeFile(path.join(root, 'shaders/final.fsh'), '#version 430\n#include "missing.glsl"\nvoid main(){}')
    await expect(service.exportShader(project, true)).rejects.toThrow('检查未通过')
  })
  it('validates actual Iris metadata, deploys verified ZIP with old-package backup and reads only new log evidence', async () => {
    const { root, project } = await fixture(), instance = path.join(root, 'game')
    await fs.mkdir(path.join(instance, 'mods'), { recursive: true })
    await fs.writeFile(path.join(instance, 'mods', 'iris-fake.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"id":"not-iris"}') }]))
    await expect(service.bindShaderInstance(project, instance)).rejects.toThrow('没有检测到')
    await fs.writeFile(path.join(instance, 'mods', 'renamed.jar'), createStoredZip([{ name: 'fabric.mod.json', data: Buffer.from('{"id":"iris","version":"fixture"}') }]))
    await service.bindShaderInstance(project, instance)
    const artifact = await service.exportShader(project)
    await fs.mkdir(path.join(instance, 'logs')); await fs.mkdir(path.join(instance, 'shaderpacks'))
    await fs.writeFile(path.join(instance, 'logs/latest.log'), `old selected ${path.basename(artifact.path)}\n`)
    await fs.writeFile(path.join(instance, 'shaderpacks', path.basename(artifact.path)), 'old')
    const deployed = await service.deployShader(project)
    // Deployment exports a fresh ZIP; its DOS timestamps may differ from the earlier export.
    const exportedBytes = await fs.readFile(artifact.path)
    const deployedBytes = await fs.readFile(deployed.deployed!.path)
    expect(deployed.irisDetected).toBe(true)
    expect(deployed.deployed).toMatchObject({ revision: artifact.revision })
    expect(await fs.realpath(deployed.deployed!.path)).toBe(await fs.realpath(path.join(instance, 'shaderpacks', path.basename(artifact.path))))
    expect(deployed.deployed?.sha256).toBe(createHash('sha256').update(exportedBytes).digest('hex'))
    expect(createHash('sha256').update(deployedBytes).digest('hex')).toBe(deployed.deployed?.sha256)
    expect(deployedBytes).toEqual(exportedBytes)
    expect(deployed.log).toMatchObject({ fresh: false, packMentioned: false, text: '' })
    const backups = await fs.readdir(path.join(instance, 'shaderpacks/.modmind-backups'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(instance, 'shaderpacks/.modmind-backups', backups[0]), 'utf8')).toBe('old')
    await fs.appendFile(path.join(instance, 'logs/latest.log'), `new selected ${path.basename(artifact.path)}\nIris shader compilation error\n`)
    const state = await service.shaderTestState(project)
    expect(state.log).toMatchObject({ fresh: true, packMentioned: true })
    expect(state.log?.issues).toEqual(['Iris shader compilation error'])
    await fs.mkdir(path.join(instance, 'screenshots')); await fs.writeFile(path.join(instance, 'screenshots/qa-corrupt.png'), 'corrupt')
    const corrupt = await service.shaderTestState(project)
    expect(corrupt.log?.issues).toEqual(['Iris shader compilation error'])
    expect(corrupt.warnings).toEqual(['截图暂不可读取：qa-corrupt.png'])
  })
})
