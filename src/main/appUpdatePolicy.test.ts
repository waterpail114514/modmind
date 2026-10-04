import { describe, expect, it } from 'vitest'
import { compareSemanticAppVersions, decideAppUpdate, parseAppVersion } from './appUpdatePolicy'

describe('app update policy', () => {
  it('parses stable and beta versions', () => {
    expect(parseAppVersion('1.3.12')).toMatchObject({ channel: 'stable', prerelease: [] })
    expect(parseAppVersion('1.4.0-beta.2')).toMatchObject({ channel: 'beta', prerelease: ['beta', '2'] })
    expect(parseAppVersion('../1.4.0')).toBeNull()
  })

  it('uses semantic prerelease ordering', () => {
    expect(compareSemanticAppVersions('1.4.0-beta.2', '1.4.0-beta.1')).toBeGreaterThan(0)
    expect(compareSemanticAppVersions('1.4.0', '1.4.0-beta.9')).toBeGreaterThan(0)
    expect(compareSemanticAppVersions('1.4.0-beta.1', '1.4.0')).toBeLessThan(0)
  })

  it('never offers beta releases to stable installations', () => {
    expect(decideAppUpdate('1.3.11', '1.4.0-beta.3')).toMatchObject({
      currentChannel: 'stable', targetChannel: 'beta', updateAvailable: false
    })
  })

  it('offers newer beta releases to beta installations', () => {
    expect(decideAppUpdate('1.4.0-beta.1', '1.4.0-beta.3')).toMatchObject({ updateAvailable: true })
    expect(decideAppUpdate('1.4.0-beta.3', '1.4.0-beta.2')).toMatchObject({ updateAvailable: false })
  })

  it.each([
    ['1.5.0-preview.1', '1.4.14', false],
    ['1.5.0-preview.1', '1.4.99', false],
    ['1.5.0-preview.1', '1.5.0', true],
    ['1.5.0-preview.1', '1.5.1', true],
    ['1.5.0-preview.1', '1.6.0', true],
    ['2.0.0-beta.5', '1.3.12', false]
  ])('offers a stable upgrade from %s to %s only when newer', (current, latest, updateAvailable) => {
    expect(decideAppUpdate(current, latest)).toMatchObject({
      currentChannel: 'beta', targetChannel: 'stable', updateAvailable
    })
  })

  it('offers only newer stable releases to stable installations', () => {
    expect(decideAppUpdate('1.3.11', '1.3.12')).toMatchObject({ updateAvailable: true })
    expect(decideAppUpdate('1.3.12', '1.3.12')).toMatchObject({ updateAvailable: false })
    expect(decideAppUpdate('1.3.13', '1.3.12')).toMatchObject({ updateAvailable: false })
  })
})
