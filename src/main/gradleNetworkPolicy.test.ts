import { expect, it } from 'vitest'
import { boundedGradleJavaOptions } from './gradleNetworkPolicy'

it('bounds direct Java and Gradle HTTP downloads without losing proxy or quoted Java options', () => {
  const previous = '-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890 -Dcustom="path with spaces"'
  const options = boundedGradleJavaOptions(previous)
  expect(options).toContain(previous)
  expect(options).toContain('-Dsun.net.client.defaultReadTimeout=60000')
  expect(options).toContain('-Dorg.gradle.internal.http.socketTimeout=60000')
  expect(boundedGradleJavaOptions(options)).toBe(options)
})

it('replaces unlimited and invalid timeouts while retaining explicitly configured positive values', () => {
  const options = boundedGradleJavaOptions('-Dsun.net.client.defaultReadTimeout=0 -Dsun.net.client.defaultConnectTimeout="45000" -Dorg.gradle.internal.http.socketTimeout=invalid')
  expect(options).not.toContain('Timeout=0')
  expect(options).not.toContain('Timeout=invalid')
  expect(options).toContain('defaultConnectTimeout="45000"')
  expect(options).toContain('defaultReadTimeout=60000')
  expect(options).toContain('socketTimeout=60000')
})
