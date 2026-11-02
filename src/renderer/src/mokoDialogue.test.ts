import { describe, expect, it } from 'vitest'
import { mokoAccountLine } from './mokoDialogue'
import { freshOnboarding, parseOnboarding, resumeOnboarding } from './onboarding'

describe('Moko account and tutorial boundaries', () => {
  it('does not greet an API connection as a signed-in person', () => {
    const line = mokoAccountLine({ status: 'connected', configured: true, provider: 'custom', username: 'should-not-be-a-person' })
    expect(line.text).not.toContain('should-not-be-a-person')
    expect(line.text).toContain('AI')
  })
  it('uses the real display name only for a connected account', () => {
    expect(mokoAccountLine({ status: 'connected', configured: true, username: '  旅行者  ' }).text).toBe('啊，旅行者！')
    expect(mokoAccountLine({ status: 'connected', configured: true }).text).toBe('登录好啦！')
    expect(mokoAccountLine({ status: 'error', configured: true, username: 'old-user' }).text).not.toContain('old-user')
    expect(mokoAccountLine({ status: 'authorizing', configured: true }).pose).toBe('think')
  })
  it('resumes the saved introduction after the account dialog or a restart', () => {
    const session = parseOnboarding(JSON.stringify({ ...freshOnboarding(), status: 'paused', introStep: 'account', experience: 'new' }))
    expect(resumeOnboarding(session)).toMatchObject({ phase: 'experience', introStep: 'account', experience: 'new', status: 'running' })
  })
  it('drops unrecognized dialogue state without losing a valid project route', () => {
    const session = parseOnboarding(JSON.stringify({ ...freshOnboarding(), phase: 'task', goal: 'mod', introStep: 'injected-step', experience: { invalid: true } }))
    expect(session).toMatchObject({ phase: 'task', goal: 'mod' })
    expect(session.introStep).toBeUndefined()
    expect(session.experience).toBeUndefined()
  })
})
