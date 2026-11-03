import { describe, expect, it, vi } from 'vitest'
import { providerFixture } from './__fixtures__/providerSync'
import * as network from './networkRequest'
import {
  normalizeSiteUrl,
  openAiV1BaseUrl,
  orderModelsForAgent,
  parseDeviceDeepLink,
  parseModelPayload,
  checkAppVersion,
  pollDeviceCode,
  queryDeviceUsage,
  requestDeviceCode,
  requestDeviceImageLease,
  queryDeviceImageProvider,
  createDeviceImageLeaseIdentity,
  sendDeviceFastMode
} from './deviceIntegration'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('device authorization v2', () => {
  it('declares v2 and consumes all connections instead of the legacy top-level key', async () => {
    const f=providerFixture()
    const fetcher=vi.fn(async()=>jsonResponse({success:true,data:{status:'ok',...f.owner().sync,username:'alice',balanceCents:'0',apiKey:'legacy-ignore',baseUrl:'https://legacy.example'}})) as unknown as typeof fetch
    const result=await pollDeviceCode('https://site.example','K7M3QX',new AbortController().signal,fetcher)
    expect(result).toMatchObject({status:'ok',apiKey:'paid-secret',sync:{connections:expect.any(Array)}})
    expect(new Headers(vi.mocked(fetcher).mock.calls[0][1]?.headers).get('X-ModMind-Sync-Version')).toBe('2')
    expect(new Headers(vi.mocked(fetcher).mock.calls[0][1]?.headers).get('X-ModMind-Sync-Capabilities')).toBe('provider-ls')
    expect(JSON.stringify(result)).not.toContain('legacy-ignore')
  })
  it.each(['ls', 'trial:one'])('accepts native LS with default %s without rewriting its inference URL', async defaultAccount => {
    const sync = providerFixture('ls').owner().sync
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: { status: 'ok', ...sync, defaultAccount, username: 'alice', balanceCents: '0' } }))
    const result = await pollDeviceCode('https://site.example', 'K7M3QX', new AbortController().signal, fetcher)
    expect(result).toMatchObject({ status: 'ok', account: defaultAccount, sync: { connections: expect.arrayContaining([expect.objectContaining({ account: 'ls', kind: 'paid', inferenceBaseUrl: 'https://paid.example/v1' })]) } })
  })
  it('ignores stale custom parameters in v2 links and rejects an invalid full connection collection',async()=>{
    expect(parseDeviceDeepLink('mcdev://sync?site=https%3A%2F%2Fsite.example&code=K7M3QX&version=2&customApi=invalid','https://site.example')).toEqual({siteUrl:'https://site.example',code:'K7M3QX'})
    const fetcher=vi.fn(async()=>jsonResponse({success:true,data:{status:'ok',protocolVersion:2,selectionRevision:1,connections:[],defaultAccount:'secondary',apiKey:'legacy',baseUrl:'https://legacy.example',balanceCents:'100',username:'alice'}})) as unknown as typeof fetch
    await expect(pollDeviceCode('https://site.example','K7M3QX',new AbortController().signal,fetcher)).rejects.toThrow('多供应商')
  })
})

describe('device integration protocol', () => {
  it('uses the application network transport by default for device requests', async () => {
    const transport = vi.spyOn(network, 'networkFetch').mockResolvedValue(jsonResponse({ success: true, data: { code: 'K7M3QX', authUrl: 'https://site.example.com/activate', expiresIn: 300 } }))
    try {
      const signal = new AbortController().signal
      await expect(requestDeviceCode('https://site.example.com', signal)).resolves.toMatchObject({ code: 'K7M3QX' })
      expect(transport).toHaveBeenCalledWith('https://site.example.com/api/device/code', expect.objectContaining({ method: 'POST', signal }))
    } finally { transport.mockRestore() }
  })
  it.each([false, true])('requests fresh image credentials using the account credential (envelope=%s)', async (envelope) => {
    let sequence = 0
    const fetcher = vi.fn(async () => {
      const data = { baseUrl: 'https://images.example.com/v1/', apiKey: `image-key-${++sequence}`, model: 'gpt-image-2' }
      return jsonResponse(envelope ? { success: true, data } : data)
    })
    const credentials = { siteUrl: 'https://site.example.com/', apiKey: 'account-key', username: 'someuser' }
    for (const index of [1, 2]) {
      await expect(requestDeviceImageLease(credentials, new AbortController().signal, fetcher))
        .resolves.toEqual({ baseUrl: 'https://images.example.com/v1', apiKey: `image-key-${index}`, model: 'gpt-image-2' })
    }
    const calls = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)
    for (const [url, init] of calls) {
      expect(url).toBe('https://site.example.com/api/device/image-lease')
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer account-key', 'Content-Type': 'application/json' } })
      expect(JSON.parse(String(init.body))).toEqual({ username: 'someuser', timestamp: expect.any(String) })
    }
    expect(new Headers(calls[0][1].headers).get('Idempotency-Key')).not.toBe(new Headers(calls[1][1].headers).get('Idempotency-Key'))
  })

  it('uses a routing session and preserves the complete independently selected image context', async () => {
    const context = { baseUrl: 'https://ls.example.com/v1', apiKey: 'temporary-ls', model: 'gpt-image-2', provider: 'ls', expiresAt: new Date(Date.now() + 600_000).toISOString() }
    const fetcher = vi.fn(async () => jsonResponse(context))
    const credentials = { siteUrl: 'https://site.example.com', apiKey: 'secondary-chat-key', routingToken: 'mdr_routing', username: 'alice' }
    await expect(requestDeviceImageLease(credentials, new AbortController().signal, fetcher)).resolves.toEqual(context)
    expect(credentials.apiKey).toBe('secondary-chat-key')
    expect(new Headers((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].headers).get('Authorization')).toBe('Bearer mdr_routing')
  })

  it.each([409, 429, 503, 0])('retries only the lease with identical UUID and timestamp (HTTP %s)', async status => {
    const context = { baseUrl: 'https://ls.example.com/v1', apiKey: 'temporary-ls', model: 'gpt-image-2', provider: 'ls' }
    let calls = 0
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
      if (++calls === 1) {
        if (!status) throw new Error('transport failed after send')
        return new Response(JSON.stringify({ message: status === 409 ? '租约处理中' : '暂时不可用' }), { status, headers: { 'Retry-After': '0' } })
      }
      return jsonResponse(context)
    })
    const identity = createDeviceImageLeaseIdentity()
    await expect(requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'mdr_session', username: 'alice' }, new AbortController().signal, fetcher, identity)).resolves.toEqual(context)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const requests = fetcher.mock.calls.map(([, init]) => ({ headers: Object.fromEntries(new Headers(init.headers)), body: init.body }))
    expect(requests[0]).toEqual(requests[1])
    expect(JSON.parse(String(requests[0].body))).toEqual({ username: 'alice', timestamp: identity.timestamp })
    expect(new Headers(requests[0].headers).get('Idempotency-Key')).toBe(identity.requestId)
  })

  it.each([401, 402, 403, 409])('does not retry a rejected or conflicting lease (HTTP %s)', async status => {
    const fetcher = vi.fn(async () => jsonResponse({ message: '当前请求不可用' }, status))
    await expect(requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'mdr_session', username: 'alice' }, new AbortController().signal, fetcher)).rejects.toMatchObject({ status })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('cancels during lease backoff before sending another authorization request', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async () => {
      setTimeout(() => controller.abort(new Error('cancelled image task')), 10)
      return new Response('{"message":"请求过于频繁"}', { status: 429, headers: { 'Retry-After': '30' } })
    })
    await expect(requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'mdr_session', username: 'alice' }, controller.signal, fetcher)).rejects.toThrow('cancelled image task')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    { model: undefined }, { model: '' }, { provider: 'unknown' }, { expiresAt: 'invalid' },
    { expiresAt: '2000-01-01T00:00:00.000Z' }
  ])('rejects incomplete or expired official image contexts (%j)', async invalid => {
    const fetcher = vi.fn(async () => jsonResponse({ baseUrl: 'https://images.example.test/v1', apiKey: 'temporary', model: 'gpt-image-2', provider: 'ls', ...invalid }))
    await expect(requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey: 'mdr_session', username: 'alice' }, new AbortController().signal, fetcher)).rejects.toThrow(/图片授权/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('queries independent image metadata without requesting an image lease', async () => {
    const metadata = { selection: 'ls', provider: 'ls', available: true, message: '生图配置已就绪', choices: [{ account: 'ls', label: 'LS', available: true }], model: 'gpt-image-2', leasePath: '/api/device/image-lease' }
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ success: true, data: metadata }))
    await expect(queryDeviceImageProvider('https://site.example.com', 'mdr_session', new AbortController().signal, fetcher)).resolves.toEqual(metadata)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://site.example.com/api/device/image-provider')
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer mdr_session')
  })

  it.each([200, 403])('redacts and bounds reflected metadata and lease errors (HTTP %s)', async status => {
    const apiKey = 'opaque-chat-secret', routingToken = 'opaque-routing-secret', ephemeral = 'sk-unknown-ephemeral-key'
    const message = `${routingToken} ${apiKey} ${ephemeral} ${'details '.repeat(2000)}`
    const fetcher = vi.fn(async () => jsonResponse({ success: false, message }, status))
    const metadata = await queryDeviceImageProvider('https://site.example.com', routingToken, new AbortController().signal, fetcher, [apiKey]).catch(error => error as Error)
    const lease = await requestDeviceImageLease({ siteUrl: 'https://site.example.com', apiKey, routingToken, username: 'alice' }, new AbortController().signal, fetcher).catch(error => error as Error)
    for (const error of [metadata, lease]) {
      expect(error).toBeInstanceOf(Error)
      const text = (error as Error).message
      for (const secret of [apiKey, routingToken, ephemeral]) expect(text).not.toContain(secret)
      expect(text).toContain('[REDACTED]')
      expect(text.length).toBeLessThan(1200)
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stops reading oversized metadata errors before reflecting their bodies', async () => {
    let reads = 0
    const cancelled = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new TextEncoder().encode('opaque-routing-secret'.repeat(1024))) },
      cancel: cancelled
    }), { status: 403 }))
    const error = await queryDeviceImageProvider('https://site.example.com', 'opaque-routing-secret', new AbortController().signal, fetcher).catch(error => error as Error)
    expect((error as Error).message).not.toContain('opaque-routing-secret')
    expect((error as Error).message.length).toBeLessThan(100)
    expect(reads).toBeLessThan(6)
    expect(cancelled).toHaveBeenCalledOnce()
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
    expect(new Headers((vi.mocked(fetcher).mock.calls[0] as [string, RequestInit])[1].headers).has('X-ModMind-Custom-Local')).toBe(false)
  })

  it('validates a local custom API deep link and sends only the declaration header to poll', async () => {
    const customApi = {
      version: 1, providerId: 'provider-1', baseUrl: 'https://text.example.com/v1/', apiKey: 'text-secret', model: 'text-model',
      imageApi: { baseUrl: 'https://images.example.com/v1/', apiKey: 'image-secret', model: 'image-model' }
    }
    const link = `mcdev://sync?site=${encodeURIComponent('https://site.example.com')}&code=K7M3QX&customApi=${Buffer.from(JSON.stringify(customApi)).toString('base64url')}`
    expect(parseDeviceDeepLink(link, 'https://site.example.com')).toEqual({
      siteUrl: 'https://site.example.com', code: 'K7M3QX',
      customApi: { ...customApi, baseUrl: 'https://text.example.com/v1', imageApi: { ...customApi.imageApi, baseUrl: 'https://images.example.com/v1' } }
    })
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: {
      status: 'ok', provider: 'custom', usageTracked: false, requiresLocalSync: true,
      apiKey: '', username: 'someuser'
    } })) as unknown as typeof fetch
    await expect(pollDeviceCode('https://site.example.com', 'K7M3QX', new AbortController().signal, fetcher, true)).resolves.toEqual({
      status: 'ok', provider: 'custom', usageTracked: false, requiresLocalSync: true, username: 'someuser'
    })
    const [url, init] = vi.mocked(fetcher).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://site.example.com/api/device/poll')
    expect(init.headers).toMatchObject({ 'X-ModMind-Custom-Local': '1' })
    expect(String(init.body)).toBe(JSON.stringify({ code: 'K7M3QX' }))
    expect(String(init.body)).not.toContain('text-secret')
  })

  it('rejects malformed custom parameters and a mismatched custom poll response', async () => {
    const base = 'mcdev://sync?site=https%3A%2F%2Fsite.example.com&code=K7M3QX&customApi='
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(() => parseDeviceDeepLink(base, 'https://site.example.com')).toThrow('自定义 API')
    expect(() => parseDeviceDeepLink(base + encode({ version: 2 }), 'https://site.example.com')).toThrow('版本')
    expect(() => parseDeviceDeepLink(base + encode({ version: 1, providerId: 'p', baseUrl: 'http://remote.example.com', apiKey: 'key', model: 'm', imageApi: null }), 'https://site.example.com')).toThrow('HTTPS')
    expect(() => parseDeviceDeepLink(base + encode({ version: 1, providerId: 'p', baseUrl: 'https://remote.example.com', apiKey: '', model: 'm', imageApi: null }), 'https://site.example.com')).toThrow('apiKey')
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: { status: 'ok', apiKey: '', username: 'someuser' } })) as unknown as typeof fetch
    await expect(pollDeviceCode('https://site.example.com', 'K7M3QX', new AbortController().signal, fetcher, true)).rejects.toThrow('自定义 API 授权响应无效')
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

  it('accepts plain-text versions and lets beta installations advance to stable', async () => {
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

  it.each([['1.4.14', false], ['1.5.0', true], ['1.5.1', true]])('checks preview upgrades against server version %s', async (latestVersion, updateAvailable) => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, data: { latestVersion, updateAvailable: true } })) as unknown as typeof fetch
    await expect(checkAppVersion('https://site.example.com', '1.5.0-preview.1', new AbortController().signal, fetcher)).resolves.toMatchObject({
      currentVersion: '1.5.0-preview.1', latestVersion, currentChannel: 'beta', targetChannel: 'stable', updateAvailable
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

  it('preserves bounded upstream model metadata without changing the inference identifier', () => {
    expect(parseModelPayload({ data: [{ id: 'vendor/new-model', display_name: 'New Model', name: 'old alias', family: 'Custom', description: 'Provider description', recommended: true }] })).toEqual([
      { id: 'vendor/new-model', name: 'New Model', family: 'Custom', description: 'Provider description', recommended: true }
    ])
    expect(parseModelPayload({ data: ['x'.repeat(257), 'invalid\nmodel', { id: 'gpt-6.1-sol', recommended: false }, { id: 'future-model', name: 'x'.repeat(300), description: 'y'.repeat(1200) }] })).toEqual([
      { id: 'future-model', name: 'x'.repeat(256), description: 'y'.repeat(1000) }, { id: 'gpt-6.1-sol', recommended: false }
    ])
  })

  it('reads tool calling and endpoint kind from provider capability fields', () => {
    expect(parseModelPayload({ data: [
      { id: 'vendor/agent-model', supported_parameters: ['tools', 'temperature'] },
      { id: 'vendor/plain-model', supported_parameters: ['temperature'] },
      { id: 'vendor/legacy-model' },
      { id: 'vendor/nested-capability', capabilities: { tools: true } }
    ] })).toEqual([
      { id: 'vendor/agent-model', toolCalling: true },
      { id: 'vendor/legacy-model' },
      { id: 'vendor/nested-capability', toolCalling: true },
      { id: 'vendor/plain-model', toolCalling: false }
    ])
  })

  it('marks embedding and speech endpoints an agent cannot drive', () => {
    expect(parseModelPayload({ data: ['baai/bge-m3', 'text-embedding-3-small', 'vendor/chat', 'vendor/whisper-large-v3'] }))
      .toEqual([
        { id: 'baai/bge-m3', nonChat: true },
        { id: 'text-embedding-3-small', nonChat: true },
        { id: 'vendor/chat' },
        { id: 'vendor/whisper-large-v3', nonChat: true }
      ])
  })

  it('keeps unusable catalog entries listed but out of the default slot', () => {
    const models = [
      { id: 'baai/bge-m3', nonChat: true },
      { id: 'vendor/agent', toolCalling: true },
      { id: 'vendor/unknown' },
      { id: 'vendor/no-tools', toolCalling: false }
    ]
    expect(orderModelsForAgent(models).map(model => model.id))
      .toEqual(['vendor/agent', 'vendor/unknown', 'vendor/no-tools', 'baai/bge-m3'])
    expect(models.map(model => model.id)).toEqual(['baai/bge-m3', 'vendor/agent', 'vendor/unknown', 'vendor/no-tools'])
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
