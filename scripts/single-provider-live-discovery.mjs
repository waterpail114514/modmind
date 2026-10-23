import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

// Kept separate from the live entry point so the request boundary is testable
// with synthetic credentials and without starting Electron or making requests.
export function validateDiscoveryRequest(rawUrl, init, policy) {
  const url = new URL(String(rawUrl)), method = String(init.method || 'GET').toUpperCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('ENDPOINT_NOT_ALLOWED')
  const bearer = new Headers(init.headers).get('Authorization')
  if (!bearer?.startsWith('Bearer ')) throw new Error('AUTHORIZATION_REQUIRED')
  if (url.origin === policy.site && ['/api/device/group', '/api/device/providers', '/api/device/session'].includes(url.pathname)) {
    if (!policy.bearers.has(bearer.slice(7))) throw new Error('UNRECOGNIZED_SITE_AUTHORIZATION')
    const credentialsQuery = url.search === '?credentials=1'
    if (method === 'GET' && ((url.pathname === '/api/device/group' && (!url.search || credentialsQuery)) || (url.pathname === '/api/device/providers' && credentialsQuery))) return { method, kind: 'state', path: url.pathname + url.search }
    if (method === 'POST' && !url.search && typeof init.body === 'string') {
      let body
      try { body = JSON.parse(init.body) } catch { throw new Error('INVALID_MUTATION_BODY') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_MUTATION_BODY')
      if (url.pathname === '/api/device/session' && Object.keys(body).length === 0) return { method, kind: 'session', path: url.pathname }
      if (url.pathname === '/api/device/group') {
        if (Object.keys(body).some(key => !['group', 'expectedAccount', 'expectedGroup'].includes(key))) throw new Error('CROSS_PROVIDER_MUTATION_FORBIDDEN')
        if (!policy.paidAccount || body.expectedAccount !== policy.paidAccount || !Object.hasOwn(body, 'expectedGroup') || !(body.expectedGroup === null || typeof body.expectedGroup === 'string')) throw new Error('EXACT_ACCOUNT_GUARD_REQUIRED')
        if (typeof body.group !== 'string' || !policy.groups.has(body.group)) throw new Error('UNADVERTISED_GROUP_FORBIDDEN')
        if (policy.restoreOnly && body.group !== policy.originalGroup) throw new Error('RESTORE_ONLY')
        return { method, kind: 'group', path: url.pathname, group: body.group, expectedGroup: body.expectedGroup }
      }
    }
    throw new Error('SITE_OPERATION_FORBIDDEN')
  }
  if (method === 'GET' && !url.search && policy.models.get(url.href)?.has(bearer.slice(7))) return { method, kind: 'models', path: url.pathname }
  throw new Error('INFERENCE_AND_UNRELATED_REQUESTS_FORBIDDEN')
}

// This function is serialized into an isolated Electron helper. Its imports
// intentionally live inside the function and are never executed by unit tests.
export async function discoveryHelper() {
  if (!process.argv.includes('--execute')) throw new Error('EXPLICIT_EXECUTE_REQUIRED')
  const { app, safeStorage } = require('electron')
  const fs = require('node:fs/promises'), path = require('node:path')
  const { createHash, randomUUID } = require('node:crypto')
  const { ProviderSyncService, parseProviderSnapshot, providerOwnerKey, parseModelPayload } = require('./service.cjs')
  const source = process.env.MODMIND_LIVE_PROFILE, site = process.env.MODMIND_LIVE_SITE
  const file = path.join(source, 'device-credentials.json'), sessionFile = path.join(source, 'quota-routing-session.enc')
  const markerFile = path.join(source, 'single-provider-discovery-recovery.enc'), discoveryFile = path.join(source, 'provider-model-discovery.enc')
  const reportFile = process.env.MODMIND_DISCOVERY_REPORT
  app.setName('ModMind Single Provider Discovery Verification')
  app.setPath('userData', path.join(__dirname, 'helper-profile'))
  const report = { checkedAt: new Date().toISOString(), service: 'ProviderSyncService.discoverModels', executed: true, inferenceRequests: 0, imageLeases: 0, crossProviderRequests: 0, posts: [], reads: [], groups: [], sharedModels: [], restored: false, profilePersisted: false, discoveryPersisted: false }
  const hash = value => createHash('sha256').update(value).digest('hex')
  const route = value => ({ account: value.account ?? value.provider, group: value.current ?? value.group ?? null })
  const equalRoute = (a, b) => Boolean(a && b && a.account === b.account && a.group === b.group)
  const secrets = new Set(), observed = new Map()
  const policy = { site, paidAccount: undefined, originalGroup: undefined, groups: new Set(), models: new Map(), bearers: new Set(), restoreOnly: false }
  let stored, originalHash, originalKey, ownerHash, owner, session, sessionHash, original, marker, discovery, discoveryHash, service, preferenceHash
  let initializationComplete = false, discoverySucceeded = false, stagedDiscovery = false
  const code = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : 'VERIFICATION_FAILED'
  const encrypt = value => safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  const decrypt = text => JSON.parse(safeStorage.decryptString(Buffer.from(text, 'base64')))
  async function optionalText(target) { try { return await fs.readFile(target, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('STATE_READ_FAILED') } }
  async function atomic(target, text, beforeRename) {
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      if (beforeRename) await beforeRename()
      await fs.rename(temporary, target)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  async function unchangedProfile() {
    const text = await fs.readFile(file, 'utf8')
    if (hash(text) !== originalHash) throw new Error('LOCAL_PROFILE_CHANGED')
    const current = JSON.parse(text)
    if (providerOwnerKey(current) !== ownerHash || safeStorage.decryptString(Buffer.from(current.encryptedApiKey, 'base64')).trim() !== originalKey) throw new Error('LOCAL_PROFILE_CHANGED')
    return current
  }
  async function readSession() {
    const text = await fs.readFile(sessionFile, 'utf8')
    if (hash(text) !== sessionHash) throw new Error('ROUTING_SESSION_CHANGED')
    const value = decrypt(text)
    if (value.owner !== ownerHash || !value.token || !Number.isFinite(value.expiresAt)) throw new Error('ROUTING_SESSION_INVALID')
    return value
  }
  async function writeSession(value) {
    await unchangedProfile()
    const current = await readSession()
    if (value.owner !== ownerHash || !policy.bearers.has(value.token)) throw new Error('ROUTING_SESSION_IDENTITY_CHANGED')
    if (value.pending?.scan && !equalRoute(value.pending.route, original)) throw new Error('INVALID_SCAN_RECOVERY_ROUTE')
    const text = encrypt(value), before = sessionHash
    await atomic(sessionFile, text, async () => {
      if (hash(await fs.readFile(sessionFile, 'utf8')) !== before) throw new Error('ROUTING_SESSION_CHANGED')
      await unchangedProfile()
    })
    sessionHash = hash(text); session = value
    secrets.add(value.token); policy.bearers.add(value.token)
    void current
  }
  async function saveMarker(target) {
    marker = { version: 1, owner: ownerHash, original, initialProfileHash: originalHash, target: target ?? original.group, startedAt: marker?.startedAt ?? new Date().toISOString() }
    await atomic(markerFile, encrypt(marker))
  }
  function rememberConnections(snapshot) {
    for (const connection of snapshot.connections) {
      if (connection.kind === 'paid' && connection.account !== policy.paidAccount) throw new Error('PAID_PROVIDER_CHANGED')
      secrets.add(connection.apiKey); policy.bearers.add(connection.apiKey)
      const base = connection.inferenceBaseUrl.replace(/\/$/, '')
      for (const suffix of ['/models', '/model']) {
        const url = new URL(base + suffix)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_MODEL_ENDPOINT')
        const keys = policy.models.get(url.href) ?? new Set(); keys.add(connection.apiKey); policy.models.set(url.href, keys)
      }
    }
  }
  async function guardedFetch(rawUrl, init = {}) {
    if (new URL(String(rawUrl)).origin === site) {
      const headers = new Headers(init.headers)
      headers.set('X-ModMind-Sync-Version', '2')
      headers.set('X-ModMind-Sync-Capabilities', 'provider-ls')
      init = { ...init, headers }
    }
    const operation = validateDiscoveryRequest(rawUrl, init, policy)
    if (operation.kind === 'group') {
      if (!policy.restoreOnly) await unchangedProfile()
      const durable = await readSession()
      if (!durable.pending?.scan || !equalRoute(durable.pending.route, original)) throw new Error('DURABLE_SCAN_RECOVERY_REQUIRED')
      await saveMarker(operation.group)
    }
    const entry = { method: operation.method, path: operation.path, ...(operation.kind === 'group' ? { account: policy.paidAccount, group: operation.group, expectedGroup: operation.expectedGroup } : {}) }
    const list = operation.method === 'POST' ? report.posts : report.reads
    list.push(entry)
    let response
    try { response = await fetch(rawUrl, { ...init, redirect: 'error', signal: init.signal || AbortSignal.timeout(20_000) }); entry.status = response.status }
    catch { entry.error = 'NETWORK_FAILURE'; throw new Error('NETWORK_FAILURE') }
    if (operation.kind === 'state' || operation.kind === 'session') {
      const envelope = await response.clone().json().catch(() => null)
      const data = envelope?.success === true ? envelope.data : undefined
      if (data?.username !== undefined && data.username !== stored.username) throw new Error('REMOTE_OWNER_CHANGED')
      if (operation.kind === 'session' && typeof data?.routingToken === 'string') { policy.bearers.add(data.routingToken); secrets.add(data.routingToken) }
      if (policy.paidAccount && data?.protocolVersion === 2 && Array.isArray(data.connections)) rememberConnections(parseProviderSnapshot(data))
      if (operation.path.startsWith('/api/device/group') && data && policy.paidAccount && route(data).account !== policy.paidAccount) throw new Error('PAID_PROVIDER_CHANGED')
    }
    return response
  }
  async function stateRead() {
    const response = await guardedFetch(site + '/api/device/group?credentials=1', { headers: { Authorization: 'Bearer ' + session.token, 'X-ModMind-Sync-Capabilities': 'provider-ls' } })
    const envelope = await response.json().catch(() => null)
    if (!response.ok || envelope?.success !== true || !envelope.data) throw new Error('CURRENT_ROUTE_UNAVAILABLE')
    return envelope.data
  }
  async function snapshotRead() {
    const response = await guardedFetch(site + '/api/device/providers?credentials=1', { headers: { Authorization: 'Bearer ' + session.token, 'X-ModMind-Sync-Capabilities': 'provider-ls' } })
    const envelope = await response.json().catch(() => null)
    if (!response.ok || envelope?.success !== true || !envelope.data) throw new Error('PROVIDER_SNAPSHOT_UNAVAILABLE')
    return parseProviderSnapshot(envelope.data)
  }
  async function restoreOnly() {
    policy.restoreOnly = true
    let actual = await stateRead()
    if (!equalRoute(route(actual), original)) {
      if (typeof original.group !== 'string' || !original.group) throw new Error('ORIGINAL_GROUP_NOT_RESTORABLE')
      const current = await readSession()
      if (!current.pending?.scan) await writeSession({ ...current, pending: { model: owner.sync.defaults?.model || 'recovery-model', route: original, scan: true } })
      const snapshot = await snapshotRead(), paid = snapshot.connections.find(connection => connection.account === original.account && connection.kind === 'paid')
      if (!paid) throw new Error('PAID_PROVIDER_CHANGED')
      const response = await guardedFetch(site + '/api/device/group', { method: 'POST', headers: { Authorization: 'Bearer ' + paid.apiKey, 'Content-Type': 'application/json', 'X-ModMind-Sync-Capabilities': 'provider-ls' }, body: JSON.stringify({ group: original.group, expectedAccount: original.account, expectedGroup: route(actual).group }) })
      // Never infer a mutation result from its HTTP status. Read the actual tuple.
      report.restorePostStatus = response.status
      actual = await stateRead()
    }
    if (!equalRoute(route(actual), original) || (actual.keyStatus && actual.keyStatus !== 'ACTIVE')) throw new Error('ORIGINAL_ROUTE_NOT_CONFIRMED')
    report.finalRoute = route(actual); report.restored = true
    return actual
  }
  async function persistRestored(snapshot) {
    const paid = snapshot.connections.find(connection => connection.kind === 'paid')
    if (!paid || !equalRoute(route(paid), original)) throw new Error('RESTORED_CREDENTIAL_TUPLE_UNAVAILABLE')
    const current = await unchangedProfile()
    const selected = current.encryptedConnections ? snapshot.connections.find(connection => connection.account === snapshot.defaultAccount) : paid
    if (!selected) throw new Error('RESTORED_DEFAULT_UNAVAILABLE')
    const next = { ...current, account: selected.account, group: selected.group, node: selected.node ?? undefined, baseUrl: selected.inferenceBaseUrl, encryptedApiKey: safeStorage.encryptString(selected.apiKey).toString('base64') }
    if (current.encryptedConnections) {
      const previous = decrypt(current.encryptedConnections)
      next.encryptedConnections = encrypt({ ...snapshot, ...(previous.defaults ? { defaults: previous.defaults } : {}), ...(previous.bindings ? { bindings: previous.bindings } : {}) })
    }
    const text = JSON.stringify(next, null, 2)
    await atomic(file, text, unchangedProfile)
    originalHash = hash(text); originalKey = selected.apiKey
    report.profilePersisted = true
    await saveMarker(original.group)
  }
  async function persistDiscovery() {
    if (!stagedDiscovery || !discovery || discovery.owner !== ownerHash) return
    if ((await optionalText(discoveryFile)) !== discoveryHash) throw new Error('DISCOVERY_METADATA_CHANGED')
    await atomic(discoveryFile, encrypt(discovery), async () => {
      if ((await optionalText(discoveryFile)) !== discoveryHash) throw new Error('DISCOVERY_METADATA_CHANGED')
      await unchangedProfile()
    })
    report.discoveryPersisted = true
  }
  function scrub(value) {
    if (typeof value === 'string') {
      for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]')
      return value.replace(/(?:sk-|mdr_)[A-Za-z0-9_-]+/g, '[redacted]')
    }
    if (Array.isArray(value)) return value.map(scrub)
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value
  }
  await app.whenReady()
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE')
    const initialText = await fs.readFile(file, 'utf8'); originalHash = hash(initialText); stored = JSON.parse(initialText)
    if (stored.provider === 'custom' || new URL(stored.siteUrl).origin !== site) throw new Error('OFFICIAL_PROFILE_REQUIRED')
    originalKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim()
    secrets.add(originalKey); secrets.add(stored.username); policy.bearers.add(originalKey)
    ownerHash = providerOwnerKey(stored)
    const sessionText = await fs.readFile(sessionFile, 'utf8'); sessionHash = hash(sessionText); session = decrypt(sessionText)
    if (session.owner !== ownerHash || typeof session.token !== 'string' || !session.token || session.expiresAt <= Date.now()) throw new Error('VALID_EXISTING_ROUTING_SESSION_REQUIRED')
    secrets.add(session.token); policy.bearers.add(session.token)
    const previousMarker = await optionalText(markerFile)
    marker = previousMarker ? decrypt(previousMarker) : undefined
    if (marker && (marker.owner !== ownerHash || marker.initialProfileHash !== originalHash)) throw new Error('RECOVERY_PROFILE_CHANGED')
    // The first read determines the sole allowed paid account. No writes occur.
    const freshResponse = await guardedFetch(site + '/api/device/providers?credentials=1', { headers: { Authorization: 'Bearer ' + session.token, 'X-ModMind-Sync-Capabilities': 'provider-ls' } })
    const freshEnvelope = await freshResponse.json().catch(() => null)
    if (!freshResponse.ok || freshEnvelope?.success !== true) throw new Error('PROVIDER_SNAPSHOT_UNAVAILABLE')
    const snapshot = parseProviderSnapshot(freshEnvelope.data), paid = snapshot.connections.find(connection => connection.kind === 'paid')
    if (!paid) throw new Error('ONE_PAID_PROVIDER_REQUIRED')
    policy.paidAccount = paid.account; rememberConnections(snapshot)
    const actual = await stateRead()
    original = marker?.original ?? (session.pending?.scan ? session.pending.route : route(actual))
    if (original.account !== paid.account || typeof original.group !== 'string' || !original.group) throw new Error('ORIGINAL_PAID_ROUTE_REQUIRED')
    policy.originalGroup = original.group; policy.groups.add(original.group)
    const provider = (actual.providers ?? []).find(item => item.account === paid.account && item.kind === 'paid')
    const groups = provider?.groups ?? actual.groups ?? []
    for (const group of groups) if (typeof group.id === 'string') policy.groups.add(group.id)
    report.originalRoute = original; report.advertisedGroups = groups.map(group => ({ id: group.id, label: group.label ?? group.id }))
    report.recoveryOnly = Boolean(marker || session.pending?.scan)
    const preferenceText = await optionalText(path.join(source, 'beginner-ai-preferences.json'))
    preferenceHash = hash(preferenceText ?? '')
    const savedPreferences = JSON.parse(preferenceText ?? '{}')
    const preferences = savedPreferences.current ?? savedPreferences
    const previousSnapshot = stored.encryptedConnections ? decrypt(stored.encryptedConnections) : undefined
    for (const connection of previousSnapshot?.connections ?? []) if (typeof connection.apiKey === 'string') secrets.add(connection.apiKey)
    owner = { siteUrl: site, username: stored.username, sync: { ...snapshot, ...(previousSnapshot?.defaults ? { defaults: previousSnapshot.defaults } : {}), ...(previousSnapshot?.bindings ? { bindings: previousSnapshot.bindings } : {}) } }
    const discoveryText = await optionalText(discoveryFile); discoveryHash = discoveryText; discovery = discoveryText ? decrypt(discoveryText) : null
    initializationComplete = true
    await saveMarker(original.group)
    service = new ProviderSyncService({
      read: async () => owner,
      write: async (previous, next) => {
        if (providerOwnerKey(previous) !== ownerHash || JSON.stringify(previous.sync) !== JSON.stringify(owner.sync)) throw new Error('IN_MEMORY_OWNER_CHANGED')
        const nextPaid = next.connections.find(connection => connection.kind === 'paid')
        if (!nextPaid || nextPaid.account !== policy.paidAccount) throw new Error('PAID_PROVIDER_CHANGED')
        owner = { ...owner, sync: next }; rememberConnections(next)
      }, readSession, writeSession, readDiscovery: async () => discovery,
      writeDiscovery: async value => { if (value.owner !== ownerHash) throw new Error('DISCOVERY_OWNER_CHANGED'); discovery = value; stagedDiscovery = true; await atomic(path.join(__dirname, 'staged-discovery.enc'), encrypt(value)) },
      readPreferences: async () => ({ model: preferences.model || paid.model || '', reasoningLevel: preferences.reasoningLevel || 'auto', fastMode: Boolean(preferences.fastMode), ...(preferences.account ? { account: preferences.account } : {}), ...(preferences.billing ? { billing: preferences.billing } : {}), ...(preferences.group ? { group: preferences.group } : {}) }),
      applyDefaults: async () => { throw new Error('PREFERENCE_MUTATION_FORBIDDEN') }, paidBusy: () => false, fetcher: guardedFetch,
      listModels: async connection => {
        const response = await guardedFetch(connection.inferenceBaseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + connection.apiKey } })
        if (!response.ok) throw new Error('MODEL_LIST_UNAVAILABLE')
        const models = parseModelPayload(await response.json())
        if (connection.account === policy.paidAccount) observed.set(connection.group, { account: connection.account, group: connection.group, modelIds: models.map(model => model.id) })
        return models
      }
    })
    if (typeof service.discoverModels !== 'function') throw new Error('DISCOVERY_SERVICE_NOT_READY')
    if (!report.recoveryOnly) {
      const catalog = await service.discoverModels()
      if (Array.isArray(catalog.models)) report.catalog = {
        protocolVersion: catalog.protocolVersion, stale: catalog.stale, providers: catalog.providers,
        modelOptionCount: catalog.models.length, paidOptionCount: catalog.models.filter(model => model.billing === 'quota').length,
        freeOptionCount: catalog.models.filter(model => model.billing === 'free').length,
        routes: catalog.routes,
        models: catalog.models.map(model => ({ id: model.id, account: model.account, billing: model.billing, group: model.group, available: model.available, modelEvidence: model.modelEvidence }))
      }
      report.freeModelChecks = []
      for (const connection of owner.sync.connections.filter(connection => connection.kind === 'free')) {
        const response = await guardedFetch(connection.inferenceBaseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + connection.apiKey } })
        if (!response.ok) throw new Error('FREE_MODEL_LIST_UNAVAILABLE')
        const actual = parseModelPayload(await response.json()).map(model => model.id)
        const listed = catalog.models.filter(model => model.account === connection.account && model.billing === 'free').map(model => model.id)
        const missing = listed.filter(id => !actual.includes(id))
        report.freeModelChecks.push({ account: connection.account, label: connection.label, status: response.status, listedModelIds: listed, endpointModelIds: actual, missing, verified: missing.length === 0 })
        if (missing.length) throw new Error('FREE_MODEL_LIST_MISMATCH')
      }
      discoverySucceeded = true
    }
  } catch (error) { report.error = code(error) }
  finally {
    // An exception permanently ends discovery; only the original group is legal
    // from this point. The service normally restored it in its own finally.
    policy.restoreOnly = true
    if (initializationComplete) {
      try {
        await restoreOnly()
        const snapshot = await snapshotRead()
        const restoredConnection = snapshot.connections.find(connection => connection.account === original.account && connection.kind === 'paid')
        if (!restoredConnection || !equalRoute(route(restoredConnection), original)) throw new Error('RESTORED_CREDENTIAL_TUPLE_UNAVAILABLE')
        const restoredModels = await guardedFetch(restoredConnection.inferenceBaseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + restoredConnection.apiKey } })
        if (!restoredModels.ok) throw new Error('RESTORED_MODELS_UNAVAILABLE')
        report.finalModelIds = parseModelPayload(await restoredModels.json()).map(model => model.id)
        await persistRestored(snapshot)
        const current = await readSession()
        if (current.pending?.scan && equalRoute(current.pending.route, original)) await writeSession({ ...current, pending: undefined })
        await persistDiscovery()
        await fs.rm(markerFile, { force: true })
        report.preferenceFileUnchanged = preferenceHash === hash((await optionalText(path.join(source, 'beginner-ai-preferences.json'))) ?? '')
      } catch (error) { report.restoreError = code(error) }
    }
    report.groups = [...observed.values()]
    const shared = new Map()
    for (const group of report.groups) for (const id of new Set(group.modelIds)) { const routes = shared.get(id) ?? []; routes.push(group.group); shared.set(id, routes) }
    report.sharedModels = [...shared].filter(([, groups]) => groups.length > 1).map(([model, groups]) => ({ model, groups }))
    report.success = report.restored && report.profilePersisted && (discoverySucceeded || report.recoveryOnly) && !report.error && !report.restoreError
    await fs.writeFile(reportFile, JSON.stringify(scrub(report), null, 2))
    console.log(JSON.stringify({ type: 'single-provider-discovery-summary', success: report.success, restored: report.restored, profilePersisted: report.profilePersisted, groups: report.groups.length, posts: report.posts.length }))
    app.exit(report.success ? 0 : 1)
  }
}

async function main() {
  if (!process.argv.includes('--execute')) throw new Error('EXPLICIT_EXECUTE_REQUIRED')
  const root = path.resolve(import.meta.dirname, '..')
  const output = process.env.MODMIND_DISCOVERY_OUTPUT ? path.resolve(process.env.MODMIND_DISCOVERY_OUTPUT) : path.join(root, 'test-results', 'single-provider-models-20261017', 'live-discovery')
  const profile = path.resolve(process.env.MODMIND_LIVE_PROFILE || 'E:/waterpail/AppData/Roaming/modmind')
  const helperProfile = path.join(output, 'helper-profile')
  await fs.mkdir(helperProfile, { recursive: true })
  const localState = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'))
  await fs.writeFile(path.join(helperProfile, 'Local State'), JSON.stringify({ os_crypt: Object.fromEntries(Object.entries(localState.os_crypt ?? {}).filter(([key, value]) => key.endsWith('encrypted_key') && typeof value === 'string')) }))
  try {
    await build({ stdin: { contents: "export { ProviderSyncService, parseProviderSnapshot, providerOwnerKey } from './src/main/providerSync'; export { parseModelPayload } from './src/main/deviceIntegration';", resolveDir: root, loader: 'ts' }, outfile: path.join(output, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const helper = path.join(output, 'discover.cjs')
    await fs.writeFile(helper, `const validateDiscoveryRequest = ${validateDiscoveryRequest.toString()};\n(${discoveryHelper.toString()})().catch(() => { console.log(JSON.stringify({ type: 'single-provider-discovery-summary', success: false, restored: false, error: 'HELPER_INITIALIZATION_FAILED' })); require('electron').app.exit(1); });\n`)
    const site = new URL(JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8')).siteUrl).origin
    const env = { ...process.env, MODMIND_LIVE_PROFILE: profile, MODMIND_LIVE_SITE: site, MODMIND_DISCOVERY_REPORT: path.join(output, 'report.json') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--no-error-dialogs', helper, '--execute'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16_384) }); child.stderr.resume()
    // No hard kill: the helper must have time to finish its restoration finally.
    const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', () => reject(new Error('HELPER_START_FAILED'))) })
    const summary = stdout.split(/\r?\n/).map(line => { try { return JSON.parse(line) } catch { return null } }).findLast(value => value?.type === 'single-provider-discovery-summary')
    console.log(JSON.stringify(summary ? { type: summary.type, success: summary.success === true, restored: summary.restored === true, profilePersisted: summary.profilePersisted === true, groups: Number(summary.groups) || 0, posts: Number(summary.posts) || 0 } : { type: 'single-provider-discovery-summary', success: false, restored: false }))
    process.exitCode = exitCode ?? 1
  } finally { await fs.rm(path.join(helperProfile, 'Local State'), { force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Single-provider verifier refused or failed; use --execute only after production discovery tests pass.'); process.exitCode = 1 })
}
