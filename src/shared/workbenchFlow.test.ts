import { describe, expect, it } from 'vitest'
import { discussionPrompt, engineeringHandoffPrompt, shouldAutoStartDraft, usesInspirationWorkflow, workbenchFlowBackend, workbenchFlowOptions } from './workbenchFlow'

describe('minimal workbench phases', () => {
  it('automatically hands off only a complete draft with a concrete user selection', () => {
    const project = { draft: { target: { kind: 'mod' as const, loader: 'fabric' as const, minecraftVersion: '1.21.1' } } }
    expect(shouldAutoStartDraft(project, 'Fabric')).toBe(true)
    expect(shouldAutoStartDraft(project, '制作 Fabric 1.21.1 模组')).toBe(true)
    expect(shouldAutoStartDraft({ draft: { target: { kind: 'mod' } } }, '模组')).toBe(false)
    expect(shouldAutoStartDraft({}, 'Fabric')).toBe(false)
    for (const message of ['推荐 Fabric 吗？', 'Fabric 还是 Forge', '先讨论 Fabric', '解释 Fabric 1.21.1', '不要制作', '好的']) {
      expect(shouldAutoStartDraft(project, message), message).toBe(false)
    }
  })

  it('keeps discussion under workspace ownership while using the existing read-only workflow', () => {
    const options = workbenchFlowOptions(true)
    expect(options.surface).toBe('workspace')
    expect(usesInspirationWorkflow(options)).toBe(true)
    expect(usesInspirationWorkflow({ surface: 'inspiration' })).toBe(true)
    expect(usesInspirationWorkflow(workbenchFlowOptions(false))).toBe(false)
  })

  it('uses quota for beginner discussion and an explicit handoff even after a UI switch', () => {
    expect(workbenchFlowBackend('beginner', 'claude', false)).toBe('quota')
    expect(workbenchFlowBackend('advanced', 'claude', true)).toBe('quota')
    expect(workbenchFlowBackend('advanced', 'claude', false)).toBe('claude')
  })

  it('hands off the conversation and actual project context without claiming discussion made changes', () => {
    const history = '用户：做一把剑\n助手：先做蓝色版本'
    const discussion = discussionPrompt('伤害低一点', history, { name: '闪电剑', loader: 'forge', minecraftVersion: '1.20.1' })
    expect(discussion).toContain('Minecraft 1.20.1')
    expect(discussion).toContain('加载器 forge')
    expect(discussion).toContain(history)
    expect(discussion).toContain('不要写文件')
    const handoff = engineeringHandoffPrompt(history)
    expect(handoff).toContain(history)
    expect(handoff).toContain('用户已点击“开始制作”')
    expect(handoff).toContain('讨论中的建议不等于已完成的修改')
  })
})
