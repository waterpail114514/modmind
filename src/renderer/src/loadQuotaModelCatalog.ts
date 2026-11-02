import type { QuotaModelCatalog } from '../../shared/quotaModels'

/** Show the last local inventory before reading the website catalog. */
export async function loadQuotaModelCatalog(onCached: (catalog: QuotaModelCatalog) => void, discover = false, force = false): Promise<QuotaModelCatalog> {
  const saved = await window.modmind.device.getModelCatalog(false, true).catch(() => undefined)
  if (saved?.models.length) onCached(saved)
  return discover ? window.modmind.device.discoverModels() : window.modmind.device.getModelCatalog(force)
}
