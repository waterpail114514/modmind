import { describe, expect, it } from 'vitest'
import {
  HEADLESS_MC_LAUNCHER_SHA256,
  HEADLESS_MC_LAUNCHER_MIRROR_URL,
  HEADLESS_MC_LAUNCHER_URL,
  HEADLESS_MC_VERSION,
  headlessMcLaunchCommand,
  jvmProxyArguments,
  supportsHeadlessMc
} from "../../feature-plugins/testing/src/main/headlessMcService"

describe('HeadlessMC smoke-test integration', () => {
  it('pins the official launcher release to a SHA-256 digest', () => {
    expect(HEADLESS_MC_VERSION).toBe('2.10.0')
    expect(HEADLESS_MC_LAUNCHER_URL).toBe('https://github.com/headlesshq/headlessmc/releases/download/2.10.0/headlessmc-launcher-2.10.0.jar')
    expect(HEADLESS_MC_LAUNCHER_MIRROR_URL).toBe(`https://ghfast.top/${HEADLESS_MC_LAUNCHER_URL}`)
    expect(HEADLESS_MC_LAUNCHER_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('only enables documented loader targets and uses the LWJGL headless command', () => {
    expect(supportsHeadlessMc('fabric')).toBe(true)
    expect(supportsHeadlessMc('forge')).toBe(true)
    expect(supportsHeadlessMc('neoforge')).toBe(true)
    expect(supportsHeadlessMc('quilt')).toBe(false)
    expect(headlessMcLaunchCommand('fabric', '1.21.1')).toBe('launch fabric:1.21.1 -lwjgl')
    expect(headlessMcLaunchCommand('fabric', '1.21.1', true)).toBe('launch fabric:1.21.1 -lwjgl -offline')
    expect(headlessMcLaunchCommand('fabric', '1.21.1', true, 'fabric-loader-0.19.3-1.21.1')).toBe('launch fabric-loader-0.19.3-1.21.1 -lwjgl -offline')
    expect(() => headlessMcLaunchCommand('quilt', '1.21.1')).toThrow(/暂不支持/)
  })

  it('omits JVM proxy arguments when no proxy environment is configured', () => {
    expect(jvmProxyArguments({})).toEqual([])
  })

  it('forwards HTTPS_PROXY as JVM https proxy properties', () => {
    const args = jvmProxyArguments({ HTTPS_PROXY: 'http://127.0.0.1:7890' })
    expect(args).toContain('-Dhttps.proxyHost=127.0.0.1')
    expect(args).toContain('-Dhttps.proxyPort=7890')
  })

  it('falls back to HTTP_PROXY and keeps authentication userinfo', () => {
    const args = jvmProxyArguments({ HTTP_PROXY: 'http://user:secret@proxy.local:8080' })
    expect(args).toContain('-Dhttps.proxyHost=proxy.local')
    expect(args).toContain('-Dhttps.proxyPort=8080')
    expect(args).toContain('-Dhttps.proxyUser=user:secret')
  })

  it('maps NO_PROXY exclusions to the JVM nonProxyHosts syntax', () => {
    const args = jvmProxyArguments({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,.internal'
    })
    expect(args).toContain('-Dhttp.nonProxyHosts=localhost|127.0.0.1|.internal')
  })

  it('ignores malformed proxy values instead of breaking launch', () => {
    expect(jvmProxyArguments({ HTTPS_PROXY: '::not-a-url::' })).toEqual([])
    expect(jvmProxyArguments({ HTTPS_PROXY: '' })).toEqual([])
  })
})

describe('HeadlessMC transcript download parsing', () => {
  it('extracts the percent from launcher library progress lines', () => {
    expect(/Downloading Libraries\s+(\d+)%/.exec('Downloading Libraries  37% [####      ] 21/56 (0:00:30 / 0:01:10)')?.[1]).toBe('37')
    expect(/Downloading Libraries\s+(\d+)%/.exec('Downloading Libraries   0%')?.[1]).toBe('0')
    expect(/Downloading Libraries\s+(\d+)%/.exec('Downloading assets from https://resources.download.minecraft.net')).toBeNull()
  })

  it('splits carriage-return progress frames into individual lines', () => {
    const line = 'Downloading Libraries   1%\rDownloading Libraries   3%\rDownloading Libraries   5%'
    expect(line.split(/\r?\n/).flatMap((part) => part.split(/\r+\s*/)).filter(Boolean)).toHaveLength(3)
  })

  it('matches asset download source lines', () => {
    expect(/Downloading assets from (\S+)/.exec('Downloading assets from https://bmclapi2.bangbang93.com/assets')?.[1]).toBe('https://bmclapi2.bangbang93.com/assets')
  })
})
