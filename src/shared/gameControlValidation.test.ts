import { expect, it } from 'vitest'
import { validateGameTestInput } from './gameControl'

it.each([
  ['session', { operation: 'start', mode: 'rendered', hidden: 'false' }],
  ['action', { operation: 'click', sessionId: 'owned', x: -1, y: 0 }],
  ['action', { operation: 'key', sessionId: 'owned', unexpected: true }],
  ['action', { operation: 'batch', sessionId: 'owned', steps: [{ operation: 'key', key: 'W', durationMs: 5001 }] }],
  ['action', { operation: 'combo', sessionId: 'owned', keys: ['W', 'W'] }],
  ['capture', {}],
  ['observe', { sessionId: 'owned', after: NaN }],
  ['__proto__', {}]
])('rejects malformed %s input consistently before service dispatch', (category, input) => {
  expect(() => validateGameTestInput(category as string, input)).toThrow()
})

it('accepts the advertised bounded action, session and observation vocabulary', () => {
  expect(() => {
    validateGameTestInput('session', { operation: 'start', mode: 'rendered', backend: 'background', width: 640, height: 360, withoutProjectMod: true })
    validateGameTestInput('action', { operation: 'batch', sessionId: 'owned', steps: [{ operation: 'key', key: 'W', durationMs: 5000 }, { operation: 'text', text: '中文' }] })
    validateGameTestInput('observe', { operation: 'result', sessionId: 'owned', requestId: '01234567-89ab-cdef-0123-456789abcdef' })
    validateGameTestInput('capture', { sessionId: 'owned' })
  }).not.toThrow()
})
