import { describe, expect, it } from 'vitest'
import { forgeInstallerVersion } from './forgeInstallerVersion'

describe('Forge installer version', () => {
  it('removes the legacy suffix that XMCL appends to 1.7 and 1.8 artifacts', () => {
    expect(forgeInstallerVersion('1.7.10', '1.7.10-10.13.4.1614-1.7.10')).toBe('10.13.4.1614')
    expect(forgeInstallerVersion('1.8.9', '1.8.9-11.15.1.2318-1.8.9')).toBe('11.15.1.2318')
  })

  it('keeps modern and already normalized versions intact', () => {
    expect(forgeInstallerVersion('1.20.1', '1.20.1-47.4.0')).toBe('47.4.0')
    expect(forgeInstallerVersion('1.7.10', '10.13.4.1614')).toBe('10.13.4.1614')
  })
})
