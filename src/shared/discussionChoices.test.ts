import { describe, expect, it } from 'vitest'
import { splitDiscussionChoices } from './discussionChoices'

const options = [
  { label: '先看配方', prompt: '先聊聊这把剑的合成配方', action: 'discussion' },
  { label: '调整伤害', prompt: '我想降低伤害，先讨论数值', action: 'discussion' },
  { label: '按这个方案制作', prompt: '确认制作蓝色闪电剑，使用刚才确定的方案', action: 'engineering' }
]
const reply = (choices: unknown) => `方案如下。\n<modmind-choices>${JSON.stringify(choices)}</modmind-choices>`

describe('discussion choices', () => {
  it('separates real AI choices from body and preserves the explicit handoff', () => {
    expect(splitDiscussionChoices(reply(options))).toEqual({ content: '方案如下。', choices: options })
  })
  it('hides incomplete or malformed protocol instead of flashing JSON', () => {
    expect(splitDiscussionChoices('回答\n<modmind-cho').content).toBe('回答')
    expect(splitDiscussionChoices('回答\n<modmind-choices>[{')).toEqual({ content: '回答', choices: [] })
    for (const invalid of [options.slice(0, 2), [options[0], options[0], options[2]], [{ ...options[0], action: 'execute' }, ...options.slice(1)]]) expect(splitDiscussionChoices(reply(invalid)).choices).toEqual([])
  })
  it('supports old followups and trailing numbered choices without inferring write permission', () => {
    const old = splitDiscussionChoices('你想选择哪种？\n1. Forge 1.20.1\n2. Fabric 1.21.1\n3. 暂时只聊玩法')
    expect(old.choices).toHaveLength(3)
    expect(old.choices.every(choice => choice.action === 'discussion')).toBe(true)
    expect(splitDiscussionChoices('正文\n<modmind-followups>["甲","乙","丙"]</modmind-followups>').choices).toHaveLength(3)
    expect(splitDiscussionChoices('安装步骤\n1. 下载\n2. 安装\n3. 完成').choices).toHaveLength(0)
  })
  it('does not disguise engineering as a question', () => {
    const parsed = splitDiscussionChoices(reply([{ ...options[0], action: 'engineering' }, ...options.slice(1)]))
    expect(parsed.choices[0].action).toBe('discussion')
  })
})
