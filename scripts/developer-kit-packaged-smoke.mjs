import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const workspace = path.resolve(import.meta.dirname, '..')
const kit = path.resolve(process.argv[2] || path.join(workspace, 'test-results/developer-workbench/package-check/win-unpacked/resources/developer-kit'))
const output = path.join(workspace, 'test-results/developer-workbench/packaged-kit-verification')
await fs.mkdir(output, { recursive: true })
await build({ entryPoints: [path.join(workspace, 'src/main/developer/service.ts')], outfile: path.join(output, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { DeveloperService } = require(path.join(output, 'service.cjs'))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-packaged-kit-'))
const service = new DeveloperService(kit, path.join(temporary, 'profile'))
const results = []
try {
  for (const kind of ['feature', 'studio']) {
    const state = await service.create(temporary, { id: `packaged-${kind}`, name: '分发组件验收', kind })
    const build = await service.build(state.project.session)
    const debug = await service.debug(state.project.session, { operation: 'tool', name: `modmind_packaged_${kind}_check`, input: { text: '实际分发资源' } })
    assert.equal(debug.result.characters, 6)
    assert.equal(debug.status, 'completed')
    assert.ok(debug.mcp.response.result)
    const preview = await service.preview(state.project.session)
    assert.ok(preview.html.includes('__modmindRegisterFeature'))
    if (kind === 'studio') {
      const created = await service.debug(state.project.session, { operation: 'create-studio', input: { name: '已打包工作台' } })
      assert.equal(created.result.verified, true)
      assert.equal(await fs.readFile(path.join(created.projectPath, 'draft.md'), 'utf8'), '# 已打包工作台\n\n')
    }
    const artifact = await service.artifact(state.project.session)
    assert.ok((await fs.stat(artifact.file)).size > 1000)
    const imported = await service.importPackage(artifact.file, temporary)
    assert.equal(imported.project.sourceMode, 'package')
    const importedBuild = await service.build(imported.project.session)
    const importedDebug = await service.debug(imported.project.session, { operation: 'tool', name: `modmind_packaged_${kind}_check`, input: { text: '实际分发资源' } })
    assert.equal(importedDebug.result.characters, 6)
    results.push({ kind, buildId: build.id, archiveBytes: build.bytes, verified: true, importedBuildId: importedBuild.id, importedVerified: true })
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ kit, results }, null, 2))
  console.log(JSON.stringify({ kit, results }, null, 2))
} finally { await service.close(); await fs.rm(temporary, { recursive: true, force: true }) }
