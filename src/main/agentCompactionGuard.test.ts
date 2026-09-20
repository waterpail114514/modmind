import { describe, expect, it } from 'vitest'
import { AgentCompactionGuard } from './agentCompactionGuard'

describe('compaction without progress', () => {
  const compact = (id: string) => ({ id, type: 'contextCompaction' })
  const read = (id: string, output = 'source A') => ({ id, type: 'commandExecution', exitCode: 0, aggregatedOutput: output, command: 'Get-Content source' })

  it('pauses after three distinct compactions in five minutes, ignoring duplicate notifications', () => {
    const guard = new AgentCompactionGuard()
    expect(guard.observe(compact('1'), 0)).toBe(false)
    expect(guard.observe(compact('1'), 1)).toBe(false)
    expect(guard.observe(compact('2'), 30_000)).toBe(false)
    expect(guard.observe(compact('3'), 60_000)).toBe(true)
  })

  it('does not count warnings, narration, failed commands or unchanged rereads as progress', () => {
    const guard = new AgentCompactionGuard()
    guard.observe(read('read-1'), 0)
    for (let i = 1; i <= 3; i++) {
      guard.observe({ ...read(`failure-${i}`, 'file missing'), exitCode: 1 }, i)
      guard.observe({ id: `message-${i}`, type: 'agentMessage', text: '先看看源码' }, i)
      guard.observe(read(`read-${i + 1}`), i)
      guard.observe(compact(String(i)), i)
    }
    expect(guard.stalled).toBe(true)
  })

  it('lets genuine new reads and edits continue, including a tool completing after the third compaction', () => {
    const guard = new AgentCompactionGuard()
    for (let i = 0; i < 10; i++) {
      guard.observe(compact(`a${i}`), i)
      guard.observe(compact(`b${i}`), i)
      guard.observe(read(`read${i}`, `source ${i}`), i)
      expect(guard.stalled).toBe(false)
    }
    for (let i = 0; i < 3; i++) guard.observe(compact(`end${i}`), 100)
    expect(guard.stalled).toBe(true)
    guard.observe({ id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: 'source', diff: '+fixed' }] }, 101)
    expect(guard.stalled).toBe(false)
  })

  it('counts successful MCP results but not repeated results or tool failures', () => {
    const guard = new AgentCompactionGuard()
    const result = { type: 'mcpToolCall', status: 'completed', tool: 'read', result: { content: [{ text: 'new fact' }] } }
    guard.observe(compact('1'), 0)
    guard.observe({ id: 'tool1', ...result }, 1)
    for (let i = 0; i < 3; i++) {
      guard.observe({ id: `tool${i+2}`, ...result }, i+2)
      guard.observe({ id: `failure${i}`, ...result, result: { isError: true, content: 'failed' } }, i+2)
      guard.observe(compact(`next${i}`), i+2)
    }
    expect(guard.stalled).toBe(true)
  })

  it('does not pause sparse compactions in an otherwise long task', () => {
    const guard = new AgentCompactionGuard()
    for (let i = 0; i < 10; i++) expect(guard.observe(compact(String(i)), i * 180_000)).toBe(false)
  })
})
