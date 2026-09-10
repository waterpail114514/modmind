import { describe, expect, it } from 'vitest'
import { splitInspirationFollowups } from './inspirationFollowups'

describe('AI generated inspiration followups', () => {
  it('separates three model-authored questions from the answer', () => {
    expect(splitInspirationFollowups('森林冒险方案。\n<modmind-followups>["如何设计奖励？","怎样安排节奏？","适合几个人玩？"]</modmind-followups>'))
      .toEqual({ content: '森林冒险方案。', options: ['如何设计奖励？', '怎样安排节奏？', '适合几个人玩？'] })
  })
  it('does not expose incomplete or invalid payloads as controls', () => {
    for (const payload of ['["a"]', '["a","a","b"]', '[{},"a","b"]', 'invalid', '["","b","c"]']) {
      expect(splitInspirationFollowups(`回答\n<modmind-followups>${payload}</modmind-followups>`)).toEqual({ content: '回答', options: [] })
    }
    expect(splitInspirationFollowups('回答\n<modmind-followups>["未完成')).toEqual({ content: '回答', options: [] })
    expect(splitInspirationFollowups('回答\n<modmind-f')).toEqual({ content: '回答', options: [] })
    expect(splitInspirationFollowups('旧的普通回答')).toEqual({ content: '旧的普通回答', options: [] })
  })
})
