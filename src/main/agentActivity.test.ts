import { describe, expect, it } from 'vitest'
import { AgentActivityTracker } from './agentActivity'
import type { AiActivity } from '../shared/aiActivity'

describe('native activity snapshots', () => {
  it('streams bounded command output on the same item and retains its failed outcome', () => {
    const events: Array<{ id: string; activity: AiActivity }> = []
    const tracker = new AgentActivityTracker((id, activity) => events.push({ id, activity }))
    tracker.item({ id: 'cmd', type: 'commandExecution', command: 'npm run check' })
    tracker.output('cmd', 'x'.repeat(20000))
    tracker.item({ id: 'cmd', type: 'commandExecution', exitCode: 1 }, true)
    expect(events.map(event => event.id)).toEqual(['cmd', 'cmd', 'cmd'])
    expect(events.at(-1)?.activity).toMatchObject({ kind: 'command', command: 'npm run check', status: 'failed' })
    expect(events.at(-1)?.activity.output).toHaveLength(12000)
    tracker.output('cmd', 'late output')
    expect(events).toHaveLength(3)
  })

  it('keeps managed background build polls on one activity until the actual result is read', () => {
    const events: Array<{ id: string; activity: AiActivity }> = []
    const tracker = new AgentActivityTracker((id, activity) => events.push({ id, activity }))
    const base = { type: 'mcpToolCall', server: 'modmind', tool: 'modmind_build_project' }
    tracker.item({ ...base, id: 'start' })
    tracker.item({ ...base, id: 'start', result: { content: [{ type: 'text', text: JSON.stringify({ taskId: 'task', status: 'running' }) }] } }, true)
    expect(events.at(-1)?.activity.status).toBe('running')
    tracker.item({ ...base, id: 'poll', arguments: { operation: 'state', taskId: 'task' } })
    tracker.output('poll', 'Compiling 5364 source files\n', true)
    expect(events.at(-1)).toMatchObject({ id: 'start', activity: { status: 'running', detail: 'Compiling 5364 source files' } })
    tracker.item({ ...base, id: 'poll', result: { content: [{ type: 'text', text: JSON.stringify({ taskId: 'task', status: 'completed', success: true }) }] } }, true)
    expect(new Set(events.map(event => event.id))).toEqual(new Set(['start']))
    expect(events.at(-1)?.activity.status).toBe('completed')
  })

  it('records exact changed paths and line counts and distinguishes failed MCP calls', () => {
    const events: AiActivity[] = []
    const tracker = new AgentActivityTracker((_, activity) => events.push(activity))
    tracker.item({ id: 'write', type: 'fileChange', changes: [{ path: 'src/main.ts', kind: { type: 'add' }, diff: '+++ src/main.ts\n+hello\n+world\n-old' }] }, true)
    expect(events[0].files).toEqual([{ path: 'src/main.ts', operation: 'create', added: 2, removed: 1 }])
    tracker.item({ id: 'mcp', type: 'mcpToolCall', tool: 'modmind_read_project_file', result: { isError: true } }, true)
    expect(events[1].status).toBe('failed')
    tracker.item({ id: 'submit', type: 'mcpToolCall', tool: 'modmind_inspiration_submit', result: { isError: true,
      content: [{ type: 'text', text: 'knowledge[0].sourceQuote 必须引用用户原文' }] } }, true)
    expect(events[2]).toMatchObject({ status: 'failed', detail: 'knowledge[0].sourceQuote 必须引用用户原文' })
  })
})
