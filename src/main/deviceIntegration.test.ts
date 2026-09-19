import { describe, expect, it, vi } from 'vitest'
import {
  normalizeSiteUrl,
  openAiV1BaseUrl,
  parseDeviceDeepLink,
  parseModelPayload,
  checkAppVersion,
  pollDeviceCode,
  queryDeviceUsage,
  requestDeviceCode,
  requestDeviceImageLease,
  sendDeviceFastMode
} from './deviceIntegration'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('device integration protocol', () => {
  it.each([false, true])('requests fresh image credentials using the account credential (envelope=%s)', async (envelope) => {
    let sequence = 0
    const fetcher = vi.fn(async () => {
      const data = { baseUrl: 'https://images.example.com/v1/', apiKey: `image-key-${++sequence}` }
      return jsonResponse(envelope ? { success: true, data } : data)
    })
    const credentials = { siteUrl: 'https://site.example.com/', apiKey: 'account-key', username: 'someuser' }
    for (const index of [1, 2]) {
      await expect(requestDeviceImageLease(credentials, new AbortController().signal, fetcher))
        .resolves.toEqual({ baseUrl: 'https://images.example.com/v1', apiKey: `image-key-${index}` })
    }
    const calls = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)
    for (const [url, init] of calls) {
      expect(url).toBe('https://site.example.com/api/device/image-lease')
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer account-key', 'Content-Type': 'application/json' } })
      expect(JSON.parse(String(init.body))).toEqual({ username: 'someuser', timestamp: expect.any(String) })
    }
    expect(new Headers(calls[0][1].headers).get('Idempotency-Key')).not.toBe(new Headers(calls[1][1].headers).get('Idempotency-Key'))
  })

  it('identifies rejected account credentials before any image API call', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: '接入凭证无效或已失效' } }, 401))
    await expect(requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'expired-account-key', username: 'someuser' }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ name: 'DeviceApiError', status: 401, message: '图片授权失败（HTTP 401）：接入凭证无效或已失效；请重新连接 ModMind 账号，或在网页端重新同步接入凭证。尚未调用生图接口' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    { body: { success: false, message: '授权失败', data: { apiKey: 'stale-key', baseUrl: 'https://images.example.com' } }, status: 200, message: '授权失败' },
    { body: { data: { baseUrl: 'https://images.example.com' } }, status: 200, message: '响应缺少临时 Key' },
    { body: { error: '额度不足' }, status: 402, message: '额度不足' }
  ])('rejects invalid image leases without treating them as account expiry ($message)', async ({ body, status, message }) => {
    const fetcher = vi.fn(async () => jsonResponse(body, status))
    const result = requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'account-key', username: 'someuser' }, new AbortController().signal, fetcher)
    await expect(result).rejects.toThrow(message)
    await expect(result).rejects.not.toThrow('请重新连接')
  })

  it('normalizes service URLs and enforces the configured deep-link origin', () => {
    expect(normalizeSiteUrl('https://site.example.com/')).toBe('https://site.example.com')
    expect(openAiV1BaseUrl('https://relay.example.com')).toBe('https://relay.example.com/v1')
    expect(openAiV1BaseUrl('https://relay.example.com/v1/')).toBe('https://relay.example.com/v1')
    expect(parseDeviceDeepLink(
      'mcdev://sync?site=https%3A%2F%2Fsite.example.com&code=6KQ8W2H5D9M4R7TX',
      'https://site.example.com'
    )).toEqual({ siteUrl: 'https://site.example.com', code: '6KQ8W2H5D9M4R7TX' })
    expect(() => parseDeviceDeepLink(
      'mcdev://sync?site=https%3A%2F%2Fevil.example.com&code=6KQ8W2H5D9M4R7TX',
      'https://site.example.com'
    )).toThrow('深链站点与应用配置不匹配')
    expect(() => parseDeviceDeepLink(
      'mcdev://sync?site=https%3A%2F%2Fsite.example.com&code=12345678901234567',
      'https://site.example.com'
    )).toThrow('深链授权码无效')
    expect(() => normalizeSiteUrl('http://site.example.com')).toThrow('HTTPS')
  })

  it('requests a device code and rejects a cross-origin authorization page', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      data: { code: 'K7M3QX', authUrl: 'https://site.example.com/auth/device?code=K7M3QX', expiresIn: 600 }
    })) as unknown as typeof fetch
    await expect(requestDeviceCode('https://site.example.com', new AbortController().signal, fetcher)).resolves.toEqual({
      code: 'K7M3QX',
      authUrl: 'https://site.example.com/auth/device?code=K7M3QX',
      expiresIn: 600
    })

    const hostileFetcher = vi.fn(async () => jsonResponse({
      success: true,
      data: { code: 'K7M3QX', authUrl: 'https://evil.example.com/auth/device?code=K7M3QX', expiresIn: 600 }
    })) as unknown as typeof fetch
    await expect(requestDeviceCode('https://site.example.com', new AbortController().signal, hostileFetcher))
      .rejects.toThrow('授权页面与配置站点不一致')
  })

  it('parses the one-time poll result without changing integer strings', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        status: 'ok',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-secret',
        balanceCents: '1234',
        username: 'someuser'
      }
    })) as unknown as typeof fetch
    await expect(pollDeviceCode('https://site.example.com', 'K7M3QX', new AbortController().signal, fetcher)).resolves.toEqual({
      status: 'ok',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-secret',
      balanceCents: '1234',
      username: 'someuser'
    })
    expect(fetcher).toHaveBeenCalledWith('https://site.example.com/api/device/poll', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ code: 'K7M3QX' })
    }))
  })

  it('queries usage with the bearer credential and preserves quota strings', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        keyStatus: 'FROZEN',
        frozenReason: '余额不足',
        balanceCents: '0',
        usedQuota: '567890',
        remainQuota: '0',
        billedCentsTotal: '987',
        lastSeenUsedQuota: '567890',
        quotaSyncedAt: '2026-08-01T10:00:00.000Z',
        checkedAt: '2026-08-01T10:00:01.000Z'
      }
    })) as unknown as typeof fetch
    const usage = await queryDeviceUsage('https://site.example.com', 'sk-secret', new AbortController().signal, fetcher)
    expect(usage).toMatchObject({ keyStatus: 'FROZEN', balanceCents: '0', usedQuota: '567890' })
    expect(fetcher).toHaveBeenCalledWith('https://site.example.com/api/device/usage', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-secret' }
    }))
  })

  it('sends only the Fast mode field accepted by the authenticated endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: {} })) as unknown as typeof fetch
    await sendDeviceFastMode('https://site.example.com', 'sk-secret', true, new AbortController().signal, fetcher)
    expect(fetcher).toHaveBeenCalledWith('https://site.example.com/api/device/fastmode', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-secret' },
      body: JSON.stringify({ enabled: true })
    }))
  })

  it('sends the current app version and parses the server version response', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: { latestVersion: '1.2.7', downloadUrl: 'https://site.example.com/download' } })) as unknown as typeof fetch
    await expect(checkAppVersion('https://site.example.com', '1.2.6', new AbortController().signal, fetcher)).resolves.toEqual({
      currentVersion: '1.2.6', latestVersion: '1.2.7', currentChannel: 'stable', targetChannel: 'stable', updateAvailable: true, downloadUrl: 'https://site.example.com/download'
    })
    expect(fetcher).toHaveBeenCalledWith('https://site.example.com/api/version', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ version: '1.2.6' })
    }))
  })

  it('accepts plain-text versions and lets beta installations return to stable', async () => {
    const fetcher = vi.fn(async () => new Response('1.3.3', { status: 200, headers: { 'Content-Type': 'text/plain' } })) as unknown as typeof fetch
    await expect(checkAppVersion('https://site.example.com', '1.3.2', new AbortController().signal, fetcher)).resolves.toMatchObject({
      latestVersion: '1.3.3', updateAvailable: true
    })
    await expect(checkAppVersion('https://site.example.com', '1.3.4', new AbortController().signal, fetcher)).resolves.toMatchObject({
      latestVersion: '1.3.3', updateAvailable: false
    })
    await expect(checkAppVersion('https://site.example.com', '1.3.3-beta.2', new AbortController().signal, fetcher)).resolves.toMatchObject({
      latestVersion: '1.3.3', targetChannel: 'stable', updateAvailable: true
    })
    await expect(checkAppVersion('https://site.example.com', '1.3.2-beta.2', new AbortController().signal, fetcher)).resolves.toMatchObject({
      latestVersion: '1.3.3', updateAvailable: true
    })
  })

  it('does not offer beta releases to stable installations', async () => {
    const fetcher = vi.fn(async () => new Response('1.4.0-beta.2', { status: 200 })) as unknown as typeof fetch
    await expect(checkAppVersion('https://site.example.com', '1.3.12', new AbortController().signal, fetcher)).resolves.toMatchObject({
      currentChannel: 'stable', targetChannel: 'beta', updateAvailable: false
    })
    await expect(checkAppVersion('https://site.example.com', '1.4.0-beta.1', new AbortController().signal, fetcher)).resolves.toMatchObject({
      currentChannel: 'beta', targetChannel: 'beta', updateAvailable: true
    })
  })

  it('uses API error messages and accepts singular or standard model payloads', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: '你的接入 Key 尚未签发' }, 500)) as unknown as typeof fetch
    await expect(pollDeviceCode('https://site.example.com', 'K7M3QX', new AbortController().signal, fetcher))
      .rejects.toEqual(expect.objectContaining({ status: 500, message: '你的接入 Key 尚未签发' }))
    expect(parseModelPayload({ model: { id: 'gpt-5.6-terra', owned_by: 'modmind' } })).toEqual([
      { id: 'gpt-5.6-terra', ownedBy: 'modmind' }
    ])
    expect(parseModelPayload({ data: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-terra' }, 'other-model'] }))
      .toEqual([{ id: 'gpt-5.6-terra' }, { id: 'other-model' }])
  })
})
