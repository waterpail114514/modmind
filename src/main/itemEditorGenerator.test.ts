import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ManagedItem, ManagedItemKind } from '../shared/itemEditor'
import type { ProjectInfo } from '../shared/types'
import { generatedItemJava, itemEditorSupportReason } from './itemEditorGenerator'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

const project: ProjectInfo = { kind: 'mod', name: 'Sample', namespace: 'sample', path: '', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: '' }
const base: ManagedItem = { id: 'sample_item', name: '样品', englishName: 'Sample', kind: 'item', stackSize: 64, durability: 0, texture: 'minecraft:item/iron_ingot' }
const equipment = (kind: ManagedItemKind): ManagedItem => ({ ...base, id: kind, kind, stackSize: 1, durability: 250,
  tier: 'iron', attackDamage: 3, attackSpeed: -2.4, armorMaterial: 'iron', armorSlot: 'helmet' })

describe('item editor Java adapters', () => {
  it('generates distinct constructors for each equipment type', () => {
    const source = generatedItemJava(project, [base, ...(['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'armor'] as const).map(equipment)])
    for (const type of ['SwordItem', 'PickaxeItem', 'AxeItem', 'ShovelItem', 'HoeItem', 'ArmorItem']) expect(source).toContain(`new ${type}(`)
    expect(source).toContain('SwordItem.createAttributes(Tiers.IRON, 3, -2.4F)')
    expect(source).toContain('ArmorMaterials.IRON, ArmorItem.Type.HELMET')
    const legacySource = generatedItemJava({ ...project, minecraftVersion: '1.20.1' }, [equipment('pickaxe'), equipment('axe'), equipment('hoe')])
    expect(legacySource).toMatch(/new PickaxeItem\([^;]+\) \{\}/)
    expect(legacySource).toMatch(/new AxeItem\([^;]+\) \{\}/)
    expect(legacySource).toMatch(/new HoeItem\([^;]+\) \{\}/)
    expect(itemEditorSupportReason({ ...project, loader: 'neoforge' })).toBeUndefined()
    expect(itemEditorSupportReason({ ...project, minecraftVersion: '26.2' })).toContain('尚未验证')
  })

  const java = process.env.MODMIND_ITEM_EDITOR_JAVAC
  const minecraft = process.env.MODMIND_ITEM_EDITOR_MINECRAFT_JAR
  const loader = process.env.MODMIND_ITEM_EDITOR_LOADER_JAR
  const compile = java && minecraft && loader ? it : it.skip
  compile('compiles all generated item types against the mapped Minecraft and loader jars', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-item-javac-'))
    roots.push(root)
    const source = path.join(root, 'ModMindItems.java')
    const compileProject = { ...project, loader: (process.env.MODMIND_ITEM_EDITOR_COMPILE_LOADER ?? 'fabric') as ProjectInfo['loader'] }
    await fs.writeFile(source, generatedItemJava(compileProject, [base, ...(['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'armor'] as const).map(equipment)]))
    const classpath = [minecraft, loader, process.env.MODMIND_ITEM_EDITOR_EXTRA_JARS].filter(Boolean).join(path.delimiter)
    const sources = [source]
    if (compileProject.loader === 'forge') {
      const dist = path.join(root, 'net/minecraftforge/api/distmarker/Dist.java')
      await fs.mkdir(path.dirname(dist), { recursive: true })
      await fs.writeFile(dist, 'package net.minecraftforge.api.distmarker; public enum Dist { CLIENT, DEDICATED_SERVER }')
      sources.push(dist)
    }
    const result = spawnSync(java!, ['-proc:none', '-d', root, '-classpath', classpath, ...sources], { encoding: 'utf8' })
    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})
