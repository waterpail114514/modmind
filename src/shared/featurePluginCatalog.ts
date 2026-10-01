import definitions from './featurePluginCatalog.json'
import type { FeaturePluginDefinition } from './featurePlugins'

// Metadata only: optional feature code is never imported into the host.
export const BUILTIN_FEATURE_CATALOG = definitions as FeaturePluginDefinition[]
