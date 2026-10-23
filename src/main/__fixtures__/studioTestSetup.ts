import { beforeEach } from 'vitest'
import mod from '../../../feature-plugins/studio-mod/manifest.json'
import pack from '../../../feature-plugins/studio-modpack/manifest.json'
import plugin from '../../../feature-plugins/studio-server-plugin/manifest.json'
import { activate as modRuntime } from '../../../feature-plugins/studio-mod/main'
import { activate as pluginRuntime } from '../../../feature-plugins/studio-server-plugin/main'
import type { FeaturePluginCatalogEntry, FeaturePluginDefinition } from '../../shared/featurePlugins'
import { configureStudios, StudioRegistry } from '../studioRegistry'

function configure(): void {
  const catalog = [mod, pack, plugin].map(manifest => ({
    id: manifest.id, name: manifest.name, version: manifest.version, manifest: manifest as FeaturePluginDefinition,
    enabled: true, installed: true, available: true, state: 'ready', installHint: ''
  })) as FeaturePluginCatalogEntry[]
  const options = { host: { inspectBuiltinStudio: async () => null, adoptBuiltinStudio: async () => null } }
  configureStudios(new StudioRegistry(() => catalog, id => id === 'studio-mod' ? modRuntime(options) : pluginRuntime(options)))
}
configure()
beforeEach(configure)
