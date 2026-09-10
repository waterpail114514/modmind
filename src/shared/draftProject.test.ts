import { describe, expect, it } from 'vitest'
import { draftTargetFromMessage, draftProjectContext, missingDraftDetails } from './draftProject'

describe('draft project conversation details', () => {
  it('retains explicit choices and accepts a later correction', () => {
    const initial = draftTargetFromMessage({}, '做一个 Forge 1.20.1 模组')
    expect(initial).toEqual({ loader: 'forge', minecraftVersion: '1.20.1', kind: 'mod' })
    expect(draftTargetFromMessage(initial, '改为 Fabric 1.21.1')).toEqual({ ...initial, loader: 'fabric', minecraftVersion: '1.21.1' })
    expect(draftTargetFromMessage({}, 'Bedrock 1.21.100 模组')).toEqual({ loader: 'bedrock', minecraftVersion: '1.21.100', kind: 'mod' })
  })
  it('does not treat alternatives, questions, negation or suggested versions as selected', () => {
    for (const text of ['Forge 还是 Fabric', '推荐 1.20.1 吗', '不用 Forge', '1.20.1 或者 1.21.1', 'Forge?', '不知道哪个版本']) expect(draftTargetFromMessage({}, text)).toEqual({})
    expect(draftTargetFromMessage({}, 'neoforge 1.21.1 整合包')).toEqual({ loader: 'neoforge', minecraftVersion: '1.21.1', kind: 'modpack' })
  })
  it('does not present placeholder metadata as an already selected target', () => {
    const project = { name: '草稿', loader: 'fabric' as const, minecraftVersion: '', draft: { target: {} } }
    expect(missingDraftDetails(project)).toHaveLength(3)
    expect(draftProjectContext(project)).toContain('占位 loader 不是用户选择')
    expect(draftProjectContext(project)).toContain('平台 未确认')
  })
})
