import definitions from './featurePluginCatalog.json'
import withdrawnIds from './withdrawnFeatureDistributions.json'
import type { FeaturePluginDefinition } from './featurePlugins'

// Metadata only: optional feature code is never imported into the host.
// Installed local copies remain discoverable through their own manifests.
export const BUILTIN_FEATURE_CATALOG = definitions.filter(entry => !withdrawnIds.includes(entry.id)) as FeaturePluginDefinition[]
