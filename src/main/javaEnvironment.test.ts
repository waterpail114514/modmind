import { expect, it } from 'vitest'
import { managedJavaEnvironment, javaProxyOptions } from './javaEnvironment'
it('preserves explicitly selected JVM options and socket directory', () => {
  const options = '-Xmx1G -Djdk.net.unixdomain.tmpdir=C:/Temp/custom'
  expect(managedJavaEnvironment({ JAVA_TOOL_OPTIONS: options }).JAVA_TOOL_OPTIONS).toBe(options)
})
it('uses a real Windows directory for local Java sockets without accumulating options', () => {
  const first = managedJavaEnvironment({ LOCALAPPDATA: process.env.LOCALAPPDATA })
  expect(managedJavaEnvironment(first).JAVA_TOOL_OPTIONS).toBe(first.JAVA_TOOL_OPTIONS)
  if (process.platform === 'win32') expect(first.JAVA_TOOL_OPTIONS).toContain('jdk.net.unixdomain.tmpdir=')
})
it('does not put proxy credentials in JVM command line properties', () => {
  const result = javaProxyOptions('http://user:secret@localhost:7890')
  expect(result).toContain('https.proxyPort=7890')
  expect(result).not.toContain('secret')
})
