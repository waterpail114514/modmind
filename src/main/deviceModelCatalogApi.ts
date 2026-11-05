import { isSelectableQuotaModel } from '../shared/quotaModels'
import { validProviderAccount, PROVIDER_SYNC_CAPABILITY_HEADERS } from '../shared/providerAccounts'
import { networkFetch, type ProxiedFetch } from './networkRequest'

export interface DeviceModelCatalogFields {
  modelsUrl?: string
  modelsReady?: boolean
  modelsVersion?: string
  modelsUpdatedAt?: string | null
  modelsStale?: boolean
}

export function modelCatalogFields(value: Record<string, unknown>): DeviceModelCatalogFields {
  return {
    ...(typeof value.modelsUrl === 'string' && value.modelsUrl.length <= 2048 ? { modelsUrl: value.modelsUrl } : {}),
    ...(typeof value.modelsReady === 'boolean' ? { modelsReady: value.modelsReady } : {}),
    ...(typeof value.modelsVersion === 'string' ? { modelsVersion: value.modelsVersion.slice(0, 256) } : {}),
    ...(value.modelsUpdatedAt === null || typeof value.modelsUpdatedAt === 'string' ? { modelsUpdatedAt: value.modelsUpdatedAt } : {}),
    ...(typeof value.modelsStale === 'boolean' ? { modelsStale: value.modelsStale } : {})
  }
}

/** Only the configured website may receive device credentials. Refresh URLs follow its current group. */
export function modelCatalogPath(siteUrl: string, account?: string, modelsUrl?: string, group?: string): string {
  const fallback = new URL('/api/device/models', siteUrl)
  if (account) fallback.searchParams.set('account', account)
  let target = fallback
  if (modelsUrl) {
    try {
      const candidate = new URL(modelsUrl, siteUrl)
      if (candidate.origin === fallback.origin && candidate.pathname === fallback.pathname && !candidate.username && !candidate.password &&
        candidate.searchParams.getAll('account').length <= 1 && candidate.searchParams.get('account') === account &&
        [...candidate.searchParams.keys()].every(key => key === 'account')) target = candidate
    } catch { /* Use the canonical website endpoint for invalid or foreign URLs. */ }
  }
  if (group !== undefined) target.searchParams.set('group', group)
  return target.pathname + target.search
}

export function parseDeviceModelCatalog(value: Record<string, unknown>, account?: string, group?: string) {
  if (!validProviderAccount(value.account) || (account !== undefined && value.account !== account) ||
    (typeof value.group !== 'string' && value.group !== null) || (group !== undefined && value.group !== group) || value.type !== 'chat' ||
    !Array.isArray(value.models) || value.models.length > 16_384 || value.models.some(id => typeof id !== 'string') ||
    typeof value.version !== 'string' || typeof value.stale !== 'boolean' ||
    (value.source !== 'server-cache' && value.source !== 'server-config') ||
    (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))) {
    throw new Error('官网模型目录返回无效数据，请稍后刷新')
  }
  return { account: value.account, group: value.group as string | null,
    models: [...new Set((value.models as string[]).filter(isSelectableQuotaModel))].slice(0, 512).map(id => ({ id })),
    stale: value.stale, version: value.version, updatedAt: value.updatedAt as string | null }
}

/** Legacy synced accounts use the same server cache, with no upstream fallback. */
export async function fetchDeviceModelCatalog(siteUrl: string, bearer: string, account?: string, fetcher: ProxiedFetch = networkFetch) {
  const response = await fetcher(new URL(modelCatalogPath(siteUrl, account), siteUrl), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000),
    headers: { ...PROVIDER_SYNC_CAPABILITY_HEADERS, Authorization: `Bearer ${bearer}` }
  })
  if (!response.ok) throw new Error(response.status === 503 ? '官网模型列表尚未就绪，请稍后刷新' : `无法读取官网模型列表（HTTP ${response.status}），请稍后重试`)
  const envelope = await response.json()
  if (envelope?.success !== true || !envelope.data || typeof envelope.data !== 'object') throw new Error('官网模型目录返回无效数据')
  return parseDeviceModelCatalog(envelope.data, account)
}
