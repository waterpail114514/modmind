/** Only canonical manufacturer names are eligible for budget inference. */
interface FamilyRule { provider: string; namespaces: string[]; pattern?: RegExp }
const rules: FamilyRule[] = [
  { provider: 'openai', namespaces: ['openai'], pattern: /^gpt-(\d+(?:\.\d+)?)(?:-(sol(?:-pro)?|luna(?:-pro)?|terra(?:-pro)?|astra(?:-pro)?|mini|nano|pro|codex(?:-mini|-max)?))?$/ },
  { provider: 'anthropic', namespaces: ['anthropic'] },
  { provider: 'google', namespaces: ['google'], pattern: /^gemini-(\d+(?:\.\d+)?)-(pro|flash|flash-lite)(-preview)?$/ },
  { provider: 'xai', namespaces: ['xai', 'x-ai'], pattern: /^grok-(\d+(?:\.\d+)?)(?:-(fast(?:-reasoning|-non-reasoning)?|reasoning|non-reasoning|code-fast))?$/ },
  { provider: 'deepseek', namespaces: ['deepseek'], pattern: /^deepseek-v(\d+(?:\.\d+)?)(?:-(pro|flash))?$/ },
  { provider: 'alibaba', namespaces: ['alibaba', 'qwen'], pattern: /^qwen(\d+(?:\.\d+)?)-(max(?:-prime)?|plus|flash|coder(?:-plus|-next)?|vl(?:-plus|-max)?)$/ },
  { provider: 'zai', namespaces: ['zai', 'z-ai', 'zhipuai'], pattern: /^glm-(\d+(?:\.\d+)?)(?:-(air|flash|flashx|prime))?$/ },
  { provider: 'moonshotai', namespaces: ['moonshotai'], pattern: /^kimi-k(\d+(?:\.\d+)?)(?:-(thinking|turbo|thinking-turbo))?$/ },
  { provider: 'minimax', namespaces: ['minimax'], pattern: /^minimax-m(\d+(?:\.\d+)?)(?:-(highspeed|lightning))?$/ },
  { provider: 'xiaomi', namespaces: ['xiaomi', 'xiaomimimo'], pattern: /^mimo-v(\d+(?:\.\d+)?)-(pro(?:-ultraspeed)?|flash)$/ }
]

export interface ModelFamily { provider: string; key: string; version: [number, number] }

export function parseModelFamily(model: string): ModelFamily | undefined {
  const parts = model.toLowerCase().split('/')
  if (parts.length > 2) return undefined
  const name = parts.at(-1)!
  const namespace = parts.length === 2 ? parts[0] : undefined
  for (const rule of rules) {
    if (namespace && !rule.namespaces.includes(namespace)) continue
    let version: string, variant: string
    if (rule.provider === 'anthropic') {
      const tierFirst = /^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?$/.exec(name)
      const versionFirst = /^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku)$/.exec(name)
      if (tierFirst) { version = `${tierFirst[2]}.${tierFirst[3] ?? 0}`; variant = tierFirst[1] }
      else if (versionFirst) { version = `${versionFirst[1]}.${versionFirst[2] ?? 0}`; variant = versionFirst[3] }
      else continue
    } else {
      const match = rule.pattern?.exec(name)
      if (!match) continue
      version = match[1]
      variant = (match[2] ?? 'base') + (match[3] ?? '')
    }
    const [major, minor = 0] = version.split('.').map(Number)
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined
    return { provider: rule.provider, key: `${rule.provider}:${variant}`, version: [major, minor] }
  }
  return undefined
}

export function compareModelVersions(a: ModelFamily['version'], b: ModelFamily['version']): number {
  return a[0] - b[0] || a[1] - b[1]
}
