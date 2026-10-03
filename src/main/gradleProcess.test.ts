import { describe, expect, it } from 'vitest'
import { describeProcessTermination, gradleDistributionDownloadUrl, gradleRunDirectory, MANAGED_GRADLE_BUILD_ARGUMENTS, normalizeProcessExitCode } from './gradleProcess'

describe('managed Gradle process policy', () => {
  it('always disables reusable daemons and keeps actionable output', () => {
    expect(MANAGED_GRADLE_BUILD_ARGUMENTS).toEqual(['build', '--console=plain', '--no-daemon', '--stacktrace'])
  })

  it('normalizes unsigned Windows termination codes', () => {
    expect(normalizeProcessExitCode(4_294_967_295)).toBe(-1)
    expect(describeProcessTermination(4_294_967_295, null)).toBe('进程被终止')
    expect(describeProcessTermination(null, 'SIGTERM')).toBe('进程收到 SIGTERM 后终止')
  })

  it('maps server tasks to their configured Gradle working directories', () => {
    expect(gradleRunDirectory('runServer')).toBe('run-server')
    expect(gradleRunDirectory('runGameTestServer')).toBe('run-gametest')
    expect(gradleRunDirectory('runClient')).toBe('run')
  })

  it('only starts download activity tracking for Gradle distribution archives', () => {
    expect(gradleDistributionDownloadUrl('Downloading https://mirrors.huaweicloud.com/gradle/gradle-8.12.1-bin.zip')).toBe('https://mirrors.huaweicloud.com/gradle/gradle-8.12.1-bin.zip')
    expect(gradleDistributionDownloadUrl('Downloading https://repo.maven.apache.org/maven2/org/example/library.jar')).toBeNull()
  })
})
