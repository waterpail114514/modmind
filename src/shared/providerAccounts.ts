/** Provider identity is shared by synchronization, saved selections and MCP. */
export const PAID_PROVIDER_ACCOUNTS = ['primary', 'secondary', 'ls', 'deepseek'] as const
export type PaidProviderAccount = typeof PAID_PROVIDER_ACCOUNTS[number]
export const PROVIDER_ACCOUNT_PATTERN = '^(primary|secondary|ls|deepseek|trial:[a-z0-9][a-z0-9_-]{0,63})$'
const accountPattern = new RegExp(PROVIDER_ACCOUNT_PATTERN)

export function validPaidProviderAccount(value: unknown): value is PaidProviderAccount {
  return typeof value === 'string' && (PAID_PROVIDER_ACCOUNTS as readonly string[]).includes(value)
}

export function validProviderAccount(value: unknown): value is string {
  return typeof value === 'string' && accountPattern.test(value)
}

export function validProviderKind(account: unknown, kind: unknown): boolean {
  if (!validProviderAccount(account)) return false
  return kind === 'paid' ? validPaidProviderAccount(account) : kind === 'free' && account.startsWith('trial:')
}

export const PROVIDER_SYNC_CAPABILITY_HEADERS = { 'X-ModMind-Sync-Capabilities': 'provider-ls' } as const
