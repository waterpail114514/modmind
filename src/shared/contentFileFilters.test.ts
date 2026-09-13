import { describe, expect, it } from 'vitest'
import { configModAssociation } from './contentFileFilters'

const mods = [{ id: 'create', name: 'Create' }, { id: 'create_config', name: 'Create Config' }]
describe('configuration mod association', () => {
  it.each(['config/create.toml', 'defaultconfigs/create-server.toml', 'serverconfig/create_common.json', 'config/create.client.cfg', 'config/create/nested/settings.json', 'CONFIG\\CREATE\\settings.json'])('matches known IDs in %s', file => {
    expect(configModAssociation(file, mods)?.id).toBe('create')
  })
  it('prefers an exact ID over removing a suffix', () => {
    expect(configModAssociation('config/create_config.toml', mods)?.id).toBe('create_config')
  })
  it.each(['config/shared.toml', 'config/create_addon.toml', 'assets/create.json', 'config/shared/create.toml'])('leaves uncertain ownership unassigned: %s', file => {
    expect(configModAssociation(file, mods)).toBeUndefined()
  })
  it('does not choose arbitrarily between ambiguous IDs', () => {
    expect(configModAssociation('config/create.toml', [...mods, { id: 'CREATE', name: 'Another' }])).toBeUndefined()
  })
})
