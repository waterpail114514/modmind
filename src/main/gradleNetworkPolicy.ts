// Applied to JAVA_TOOL_OPTIONS so both the wrapper and its forked daemon inherit
// the limits, including ForgeGradle's direct URLConnection downloads.
export const GRADLE_NETWORK_TIMEOUTS = {
  'sun.net.client.defaultConnectTimeout': 30_000,
  'sun.net.client.defaultReadTimeout': 60_000,
  'org.gradle.internal.http.connectionTimeout': 30_000,
  'org.gradle.internal.http.socketTimeout': 60_000
} as const

export function boundedGradleJavaOptions(previous = ''): string {
  let options = previous.trim()
  for (const [key, fallback] of Object.entries(GRADLE_NETWORK_TIMEOUTS)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(^|\\s)-D${escaped}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'g')
    let configured = false
    options = options.replace(pattern, (match, prefix, doubleQuoted, singleQuoted, plain) => {
      const value = Number(doubleQuoted ?? singleQuoted ?? plain)
      if (Number.isFinite(value) && value > 0) { configured = true; return match }
      return prefix
    }).trim()
    if (!configured) options += `${options ? ' ' : ''}-D${key}=${fallback}`
  }
  return options
}
