import { afterEach, expect, it, vi } from 'vitest'
import { quiltOfficialInstallerChecksum } from './quiltInstallerChecksum'
import * as network from './networkRequest'

afterEach(() => vi.restoreAllMocks())
const canonical = 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar'
it('reads only the exact official artifact sidecar and preserves cancellation', async () => {
  const request = vi.spyOn(network, 'fetchTextWithRetry').mockResolvedValue(`${'AB'.repeat(32)}\n`)
  const controller = new AbortController()
  expect(await quiltOfficialInstallerChecksum(canonical, controller.signal)).toBe('ab'.repeat(32))
  expect(request).toHaveBeenCalledWith(`${canonical}.sha256`, { signal: controller.signal })
})
it.each([canonical.replace('quiltmc.org', 'quiltmc.org.invalid'), canonical.replace('https:', 'http:'), `${canonical}?redirect=1`, canonical.replace('0.15.1.jar', '0.14.0.jar'), canonical.replace('quilt-installer-0.15.1.jar', 'quilt-installer-0.15.1-all.jar')])('rejects noncanonical recovery URLs: %s', async url => {
  const request = vi.spyOn(network, 'fetchTextWithRetry')
  await expect(quiltOfficialInstallerChecksum(url)).rejects.toThrow('official exact-version')
  expect(request).not.toHaveBeenCalled()
})
it.each(['<html>error</html>', 'ff'.repeat(31), `${'ff'.repeat(32)} file.jar`, 'gg'.repeat(32)])('rejects malformed sidecar %s', async response => {
  vi.spyOn(network, 'fetchTextWithRetry').mockResolvedValue(response)
  await expect(quiltOfficialInstallerChecksum(canonical)).rejects.toThrow('invalid')
})
