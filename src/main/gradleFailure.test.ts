import { describe, expect, it } from 'vitest'
import {
  isForgeJavaProvisioningFailure,
  isGradleDistributionLockFailure,
  isGradleNetworkFailure,
  isGradleWrapperBootstrapFailure
} from './gradleFailure'

describe('Gradle wrapper failure classification', () => {
  it('recognizes the actual Wrapper connect timeout after a distribution redirect', () => {
    expect(isGradleNetworkFailure('Downloading https://services.gradle.org/distributions/gradle-9.5.1-bin.zip\njava.net.ConnectException: Connection timed out: getsockopt\n at org.gradle.wrapper.Install.forceFetch(SourceFile:2)')).toBe(true)
  })
  it('recognizes wrapper distribution lock timeouts on Windows', () => {
    const log = 'Timeout of 120000 reached waiting for exclusive access to file: C:\\Users\\me\\cache\\wrapper\\dists\\gradle-9.5.1-bin\\key\\gradle-9.5.1-bin.zip'

    expect(isGradleDistributionLockFailure(log)).toBe(true)
    expect(isGradleWrapperBootstrapFailure(log)).toBe(true)
  })

  it('recognizes wrapper distribution lock timeouts on Unix', () => {
    const log = 'Timeout of 120000 reached waiting for exclusive access to file: /home/me/.gradle/wrapper/dists/gradle-9.5.1-bin/key/gradle-9.5.1-bin.zip'

    expect(isGradleDistributionLockFailure(log)).toBe(true)
  })

  it('keeps compiler failures out of bootstrap recovery', () => {
    const log = '/project/src/Main.java:12: error: cannot find symbol\nBUILD FAILED'

    expect(isGradleNetworkFailure(log)).toBe(false)
    expect(isGradleDistributionLockFailure(log)).toBe(false)
    expect(isGradleWrapperBootstrapFailure(log)).toBe(false)
  })

  it('keeps Maven dependency timeouts out of Wrapper recovery', () => {
    const log = "Could not download mercury-0.4.3.jar (net.fabricmc:mercury:0.4.3)\nCould not get resource 'https://maven.fabricmc.net/net/fabricmc/mercury/0.4.3/mercury-0.4.3.jar'.\nRead timed out"

    expect(isGradleNetworkFailure(log)).toBe(false)
    expect(isGradleWrapperBootstrapFailure(log)).toBe(false)
  })

  it('keeps Forge-managed JDK provisioning failures out of Wrapper recovery', () => {
    const log = [
      'Failed to provision JDK 8',
      'Downloading https://github.com/adoptium/temurin8-binaries/releases/download/jdk8/file.zip',
      'Caused by: java.net.http.HttpConnectTimeoutException: HTTP connect timed out'
    ].join('\n')

    expect(isForgeJavaProvisioningFailure(log)).toBe(true)
    expect(isGradleNetworkFailure(log)).toBe(false)
    expect(isGradleWrapperBootstrapFailure(log)).toBe(false)
  })
})
