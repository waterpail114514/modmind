import type { DeviceConnectionState } from './types'

/** Account status and balance updates are independent of the client's catalog. */
export function deviceModelCatalogKey(state: DeviceConnectionState): string | undefined {
  if (state.status !== 'connected') return undefined
  return JSON.stringify([state.siteUrl, state.username, state.provider, state.providerId,
    state.modelCatalogRevision ?? 0, state.provider === 'custom' ? state.model : undefined])
}
