import { describe, expect, it } from 'vitest'
import { splitDiscussionChoices } from './discussionChoices'

const options = [
  { label: '先看配方', prompt: '先聊聊这把剑的合成配方', action: 'discussion' },
  { label: '调整伤害', prompt: '我想降低伤害，先讨论数值', action: 'discussion' },
  { label: '按这个方案制作', prompt: '确认制作蓝色闪电剑，使用刚才确定的方案', action: 'engineering' }
]
const reply = (choices: unknown) => `方案如下。\n<modmind-choices>${JSON.stringify(choices)}</modmind-choices>`

describe('discussion choices', () => {
  it('accepts two natural replies with one recommendation and no routing metadata', () => {
    const choices = [
      { label: 'Fabric', prompt: '用推荐的 Fabric 1.21.1 模组方案', recommended: true },
      { label: 'Forge', prompt: '我要做 Forge 1.20.1 模组' }
    ]
    expect(splitDiscussionChoices(reply(choices)).choices).toEqual(choices.map(choice => ({ ...choice, action: 'discussion' })))
    expect(splitDiscussionChoices(reply(choices.map(choice => ({ ...choice, recommended: true })))).choices).toEqual([])
    expect(splitDiscussionChoices(reply([{ ...choices[0], recommended: 'true' }, choices[1]])).choices).toEqual([])
  })
  it('separates real AI choices from body and preserves the explicit handoff', () => {
    expect(splitDiscussionChoices(reply(options))).toEqual({ content: '方案如下。', choices: options })
  })
  it('hides incomplete or malformed protocol instead of flashing JSON', () => {
    expect(splitDiscussionChoices('回答\n<modmind-cho').content).toBe('回答')
    expect(splitDiscussionChoices('回答\n<modmind-choices>[{')).toEqual({ content: '回答', choices: [] })
    for (const invalid of [options.slice(0, 1), [options[0], options[0], options[2]], [{ ...options[0], action: 'execute' }, ...options.slice(1)]]) expect(splitDiscussionChoices(reply(invalid)).choices).toEqual([])
  })
  it('supports old followups and trailing numbered choices without inferring write permission', () => {
    const old = splitDiscussionChoices('你想选择哪种？\n1. Forge 1.20.1\n2. Fabric 1.21.1\n3. 暂时只聊玩法')
    expect(old.choices).toHaveLength(3)
    expect(old.choices.every(choice => choice.action === 'discussion')).toBe(true)
    expect(splitDiscussionChoices('正文\n<modmind-followups>["甲","乙","丙"]</modmind-followups>').choices).toHaveLength(3)
    expect(splitDiscussionChoices('安装步骤\n1. 下载\n2. 安装\n3. 完成').choices).toHaveLength(0)
  })
  it.each(['按此方案修复，只出 JAR', '交给工作台执行已确认修复', '在工作台执行既定修复', 'Fix and build'])('preserves the explicit execution action for %s', (label) => {
    const parsed = splitDiscussionChoices(reply([...options.slice(0, 2), { ...options[2], label }]))
    expect(parsed.choices[2]).toEqual({ ...options[2], label })
  })
  it('does not infer execution from a discussion label or a legacy string', () => {
    const parsed = splitDiscussionChoices(reply([{ label: '讨论如何修复并制作', prompt: '只分析，不修改', action: 'discussion' }, options[1], '按此方案修复，只出 JAR']))
    expect(parsed.choices).toHaveLength(3)
    expect(parsed.choices.every(choice => choice.action === 'discussion')).toBe(true)
  })
  it('rejects multiple execution actions without reinterpreting their labels', () => {
    expect(splitDiscussionChoices(reply([{ ...options[0], action: 'engineering' }, ...options.slice(1)])).choices).toEqual([])
  })
})
