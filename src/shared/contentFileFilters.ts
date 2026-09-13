export interface ModConfigIdentity { id: string; name: string }

/** A filename association, not proof that the mod actually reads the configuration. */
export function configModAssociation(file: string, mods: ModConfigIdentity[]): ModConfigIdentity | undefined {
  const parts = file.replaceAll('\\', '/').toLowerCase().split('/')
  if (!['config', 'defaultconfigs', 'serverconfig'].includes(parts[0])) return undefined
  const stem = parts.at(-1)!.replace(/\.[^.]+$/, '')
  const candidates = parts.length > 2 ? [parts[1]] : [stem, stem.replace(/[-_.](?:client|common|server|config)$/, '')]
  for (const candidate of candidates) {
    const matches = mods.filter(mod => mod.id.toLowerCase() === candidate)
    if (matches.length) return matches.length === 1 ? matches[0] : undefined
  }
  return undefined
}
