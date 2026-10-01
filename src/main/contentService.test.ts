import { describe, expect, it } from 'vitest'
import { buildContentFile } from "../../feature-plugins/publishing/src/main/contentService"
import type { ProjectInfo } from '../shared/types'

const project = (minecraftVersion: string): ProjectInfo => ({
  name: 'Test', path: 'C:/test', loader: 'fabric', minecraftVersion, namespace: 'testmod', createdAt: ''
})

describe('structured Minecraft content', () => {
  it('uses modern singular data directories for Minecraft 1.21', () => {
    const built = buildContentFile(project('1.21.1'), {
      kind: 'recipe-shapeless', id: 'compressed/test', data: { ingredients: ['minecraft:stone'], result: 'testmod:test', count: 1 }
    })
    expect(built.relativePath).toContain('/recipe/')
    expect(built.value.result).toEqual({ id: 'testmod:test', count: 1 })
  })

  it('uses legacy plural directories and result fields before 1.21', () => {
    const built = buildContentFile(project('1.20.1'), {
      kind: 'recipe-shapeless', id: 'test', data: { ingredients: ['minecraft:stone'], result: 'testmod:test', count: 2 }
    })
    expect(built.relativePath).toContain('/recipes/')
    expect(built.value.result).toEqual({ item: 'testmod:test', count: 2 })
  })

  it('uses version-specific advancement item predicates', () => {
    const modern = buildContentFile(project('1.21.1'), { kind: 'advancement', id: 'first', data: { icon: 'minecraft:stone', criterionItem: 'minecraft:stone' } })
    const legacy = buildContentFile(project('1.20.1'), { kind: 'advancement', id: 'first', data: { icon: 'minecraft:stone', criterionItem: 'minecraft:stone' } })
    expect((modern.value.display as { icon: unknown }).icon).toEqual({ id: 'minecraft:stone' })
    expect((legacy.value.display as { icon: unknown }).icon).toEqual({ item: 'minecraft:stone' })
    expect(((legacy.value.criteria as { obtain: { conditions: { items: Array<{ items: unknown }> } } }).obtain.conditions.items[0]).items).toEqual(['minecraft:stone'])
  })

  it('rejects shaped recipes with missing symbols', () => {
    expect(() => buildContentFile(project('1.21.1'), {
      kind: 'recipe-shaped', id: 'broken', data: { pattern: ['AA', ' B'], key: { A: 'minecraft:stone' }, result: 'minecraft:stone' }
    })).toThrow(/未定义/)
  })

  it('writes validated custom data and asset JSON paths', () => {
    const biome = buildContentFile(project('1.21.1'), {
      kind: 'data-json', id: 'worldgen/biome/crystal_fields', data: { value: { temperature: 0.7, downfall: 0.2 } }
    })
    const particle = buildContentFile(project('1.21.1'), {
      kind: 'asset-json', id: 'particles/crystal_spark', data: { value: { textures: ['testmod:crystal_spark'] } }
    })
    expect(biome.relativePath).toBe('src/main/resources/data/testmod/worldgen/biome/crystal_fields.json')
    expect(particle.relativePath).toBe('src/main/resources/assets/testmod/particles/crystal_spark.json')
  })

  it('rejects unsafe custom JSON paths and non-object JSON values', () => {
    expect(() => buildContentFile(project('1.21.1'), {
      kind: 'data-json', id: '../outside', data: { value: {} }
    })).toThrow()
    expect(() => buildContentFile(project('1.21.1'), {
      kind: 'asset-json', id: 'models/item/test', data: { value: [] }
    })).toThrow(/JSON/)
  })
})
