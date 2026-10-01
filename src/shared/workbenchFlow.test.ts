import { describe, expect, it } from 'vitest'
import { discussionPrompt, engineeringHandoffPrompt, isWorkbenchDiscussion, usesInspirationWorkflow, workbenchFlowBackend, workbenchFlowOptions } from './workbenchFlow'
import { splitDiscussionChoices } from './discussionChoices'

describe('minimal workbench phases', () => {
  it('uses one capable runner for beginner setup, options, discussion and execution', () => {
    for (const project of [{}, { draft: { target: {} } }]) {
      for (const phase of [undefined, 'discussion', 'engineering'] as const) {
        expect(isWorkbenchDiscussion(project, phase, true)).toBe(false)
      }
    }
    expect(usesInspirationWorkflow({ surface: 'workspace', agentMode: 'beginner', workbenchPhase: 'discussion' })).toBe(false)
    expect(usesInspirationWorkflow({ surface: 'inspiration', agentMode: 'beginner' })).toBe(true)
  })
  it('keeps normal messages and follow-up repairs on the capable workspace runner', () => {
    expect(usesInspirationWorkflow(workbenchFlowOptions(isWorkbenchDiscussion({})))).toBe(false)
    expect(isWorkbenchDiscussion({}, 'engineering')).toBe(false)
    expect(isWorkbenchDiscussion({}, 'discussion')).toBe(true)
  })

  it('keeps drafts read-only until the caller has initialized the project', () => {
    const draft = { draft: { target: { kind: 'mod' as const } } }
    expect(isWorkbenchDiscussion(draft)).toBe(true)
    expect(isWorkbenchDiscussion(draft, 'engineering')).toBe(true)
    expect(isWorkbenchDiscussion(draft, 'discussion')).toBe(true)
  })

  it.each(['按此方案修复，只出 JAR', '交给工作台执行已确认修复', '在工作台执行既定修复'])('routes the recorded repair choice into execution: %s', label => {
    const prompt = '执行已经确认的修复，生成新 JAR；不要启动客户端或服务器，由我手动测试。'
    const reply = `<modmind-choices>${JSON.stringify([
      { label, prompt, action: 'engineering' },
      { label: '细化人工验收步骤', prompt: '只讨论验收步骤，不修改', action: 'discussion' },
      { label: '先分析原因', prompt: '只读分析原因，不构建', action: 'discussion' }
    ])}</modmind-choices>`
    // Parse stored output again, as happens after reload, then follow the same
    // choice -> phase -> runner path as the workbench click handler.
    const choice = splitDiscussionChoices(JSON.parse(JSON.stringify(reply))).choices[0]
    expect(usesInspirationWorkflow(workbenchFlowOptions(isWorkbenchDiscussion({}, choice.action)))).toBe(false)
    expect(engineeringHandoffPrompt(choice.prompt)).toContain(prompt)
  })

  it('keeps discussion under workspace ownership while using the existing read-only workflow', () => {
    const options = workbenchFlowOptions(true)
    expect(options.surface).toBe('workspace')
    expect(usesInspirationWorkflow(options)).toBe(true)
    expect(usesInspirationWorkflow({ surface: 'inspiration' })).toBe(true)
    expect(usesInspirationWorkflow(workbenchFlowOptions(false))).toBe(false)
  })

  it('uses quota for beginner discussion and an explicit handoff even after a UI switch', () => {
    expect(workbenchFlowBackend('beginner', 'codex', false)).toBe('quota')
    expect(workbenchFlowBackend('advanced', 'codex', true)).toBe('quota')
    expect(workbenchFlowBackend('advanced', 'codex', false)).toBe('codex')
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
    expect(handoff).toContain('用户已选择执行此请求')
    expect(handoff).toContain('讨论中的建议不等于已完成的修改')
  })
})
