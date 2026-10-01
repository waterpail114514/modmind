import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import type { ProjectInfo } from '../shared/types'
import { workbenchSkillNames, workbenchSkillPrompt } from './workbenchSkillPolicy'
import { syncWorkbenchSkills } from './workbenchSkills'

it('isolates pack and module skill catalogs and removes stale bundled skills without removing custom ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-skills-'))
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target')
    for (const name of ['minecraft-mod-development', 'minecraft-modpack-authoring', 'minecraft-build-repair', 'custom-workflow']) {
      await fs.mkdir(path.join(source, name), { recursive: true })
      await fs.writeFile(path.join(source, name, 'SKILL.md'), name)
    }
    const pack = { kind: 'modpack', loader: 'fabric' } as ProjectInfo
    const module = { kind: 'mod', loader: 'fabric' } as ProjectInfo
    await syncWorkbenchSkills(source, target)
    await syncWorkbenchSkills(source, target, workbenchSkillNames(pack))
    expect((await fs.readdir(target)).sort()).toEqual(['custom-workflow', 'minecraft-modpack-authoring'])
    const packPrompt = workbenchSkillPrompt(target, pack)
    expect(packPrompt).toContain('modmind_modpack_delegate_module')
    expect(packPrompt).not.toContain('- minecraft-mod-development：')
    expect(packPrompt).not.toContain('- minecraft-build-repair：')
    await syncWorkbenchSkills(source, target, workbenchSkillNames(module))
    expect((await fs.readdir(target)).sort()).toEqual(['custom-workflow', 'minecraft-build-repair', 'minecraft-mod-development'])
    expect(workbenchSkillPrompt(target, module)).toContain('- minecraft-mod-development：')
    expect(workbenchSkillPrompt(target, module)).not.toContain('- minecraft-modpack-authoring：')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

it('removes the image skill and its routing for unavailable plugins, including drafts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-skill-'))
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target')
    await fs.mkdir(path.join(source, 'modmind-image-assets'), { recursive: true })
    await fs.writeFile(path.join(source, 'modmind-image-assets/SKILL.md'), 'image tools')
    await syncWorkbenchSkills(source, target)
    const project = { loader: 'fabric', kind: 'mod' } as ProjectInfo
    expect(workbenchSkillNames(project, false)).not.toContain('modmind-image-assets')
    expect(workbenchSkillPrompt(target, project, false)).not.toContain('modmind-image-assets')
    expect(workbenchSkillNames({ ...project, draft: {} } as ProjectInfo, false)).not.toContain('modmind-image-assets')
    await syncWorkbenchSkills(source, target, workbenchSkillNames(project, false))
    expect(await fs.readdir(target)).toEqual([])
    await syncWorkbenchSkills(source, target, workbenchSkillNames(project, true))
    expect(await fs.readdir(target)).toEqual(['modmind-image-assets'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
