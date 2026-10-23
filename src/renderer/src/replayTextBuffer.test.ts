import { expect, it } from 'vitest'
import { ReplayTextBuffer } from './replayTextBuffer'

it('matches cumulative, suffix duplicate and appended streaming text across chunk boundaries', () => {
  for (let seed = 1; seed <= 50; seed++) {
    let random = seed
    const next = (max: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max }
    let current = ''
    const buffer = new ReplayTextBuffer(current)
    for (let index = 0; index < 200; index++) {
      const fresh = `${index}:段落${next(10)}\n`
      const incoming = next(3) === 0 ? current + fresh : next(3) === 0 ? current.slice(-next(Math.max(1, current.length))) : fresh
      current = !incoming ? current : !current || incoming.startsWith(current) ? incoming : current.endsWith(incoming) ? current : current + incoming
      buffer.append(incoming)
      expect(buffer.value()).toBe(current)
    }
  }
})
