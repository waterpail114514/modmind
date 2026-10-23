import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validateDiscoveryRequest, discoveryHelper } from './single-provider-live-discovery.mjs'

const site = 'https://synthetic.invalid', key = 'synthetic-key', token = 'synthetic-token'
function policy() {
  return { site, paidAccount: 'secondary', originalGroup: 'original', restoreOnly: false, groups: new Set(['original', 'other']), bearers: new Set([key, token]), models: new Map([[site + '/v1/models', new Set([key])]]) }
}
const post = body => ({ method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: JSON.stringify(body) })
const ownGroup = { group: 'other', expectedAccount: 'secondary', expectedGroup: 'original' }

test('accepts only same-provider exact guarded group changes', () => {
  assert.equal(validateDiscoveryRequest(site + '/api/device/group', post(ownGroup), policy()).kind, 'group')
  for (const body of [{ ...ownGroup, account: 'secondary' }, { ...ownGroup, account: 'ls' }, { ...ownGroup, expectedAccount: 'ls' }, { group: 'other', expectedAccount: 'secondary' }, { ...ownGroup, group: 'unadvertised' }]) {
    assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post(body), policy()))
  }
})

test('restoration mode permanently disallows scanning another group', () => {
  const p = { ...policy(), restoreOnly: true }
  assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post(ownGroup), p), /RESTORE_ONLY/)
  assert.equal(validateDiscoveryRequest(site + '/api/device/group', post({ ...ownGroup, group: 'original', expectedGroup: 'other' }), p).group, 'original')
})

test('only permits known model-list GETs and an empty session refresh POST', () => {
  const p = policy(), headers = { Authorization: 'Bearer ' + key }
  assert.equal(validateDiscoveryRequest(site + '/v1/models', { headers }, p).kind, 'models')
  assert.equal(validateDiscoveryRequest(site + '/api/device/session', post({}), p).kind, 'session')
  for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/images/generations', '/api/device/image/lease']) assert.throws(() => validateDiscoveryRequest(site + endpoint, post({}), p))
  assert.throws(() => validateDiscoveryRequest(site + '/v1/models', { method: 'POST', headers }, p))
  assert.throws(() => validateDiscoveryRequest(site + '/v1/models', { headers: { Authorization: 'Bearer other-key' } }, p))
  assert.throws(() => validateDiscoveryRequest(site + '/api/device/session', post({ account: 'ls' }), p))
  assert.throws(() => validateDiscoveryRequest('https://elsewhere.invalid/api/device/group', post(ownGroup), p))
})

test('direct invocation refuses without --execute', () => {
  const result = spawnSync(process.execPath, [path.resolve('scripts/single-provider-live-discovery.mjs')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refused/)
  assert.equal(result.stdout, '')
})

for (const { externalProfileChange, serviceFails, nativeSnapshot } of [
  { externalProfileChange: false, serviceFails: true, nativeSnapshot: false },
  { externalProfileChange: true, serviceFails: true, nativeSnapshot: false },
  { externalProfileChange: false, serviceFails: false, nativeSnapshot: true }
]) test(`helper preserves profile/recovery contracts (${nativeSnapshot ? 'native success' : externalProfileChange ? 'concurrent profile change' : 'scan error'})`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-discovery-verifier-'))
  const file = path.join(root, 'device-credentials.json'), sessionFile = path.join(root, 'quota-routing-session.enc'), reportFile = path.join(root, 'report.json')
  const username = 'synthetic-private-user', ownerHash = createHash('sha256').update(site + '\0' + username).digest('hex')
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
  const originalProfile = { version: 1, siteUrl: site, username, account: 'secondary', group: 'original', baseUrl: site + '/v1', encryptedApiKey: Buffer.from(key).toString('base64'), balanceCents: '1' }
  const oldDefaults = { model: 'old-model', account: 'ls', group: 'old-group', billing: 'quota', reasoningLevel: 'high' }
  const oldBindings = { workspace: { ...oldDefaults }, inspiration: { model: 'free-model', account: 'trial:one', billing: 'free', reasoningLevel: 'auto' } }
  if (nativeSnapshot) originalProfile.encryptedConnections = encode({ defaults: oldDefaults, bindings: oldBindings })
  const originalText = JSON.stringify(originalProfile)
  await fs.writeFile(file, originalText)
  await fs.writeFile(sessionFile, encode({ owner: ownerHash, token, expiresAt: Date.now() + 600_000, pending: { model: 'old-model', route: { account: 'ls', group: 'old-group' } } }))
  let currentGroup = 'original', fakeRequests = [], exitCode
  const snapshot = () => ({ protocolVersion: 2, selectionRevision: 2, defaultAccount: 'secondary', connections: [{ account: 'secondary', kind: 'paid', label: 'Fixture paid', apiKey: key, baseUrl: site, inferenceBaseUrl: site + '/v1', group: currentGroup, node: null, model: 'fixture-model' }] })
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET'; fakeRequests.push({ path: u.pathname, method, body: init.body })
    if (u.pathname === '/api/device/providers') return Response.json({ success: true, data: snapshot() })
    if (u.pathname === '/api/device/group') {
      if (method === 'POST') currentGroup = JSON.parse(init.body).group
      return Response.json({ success: true, data: { account: 'secondary', current: currentGroup, keyStatus: 'ACTIVE', groups: [{ id: 'original' }, { id: 'other' }], providers: [{ account: 'secondary', kind: 'paid', groups: [{ id: 'original' }, { id: 'other' }] }] } })
    }
    if (u.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture-model' }] })
    throw new Error('unexpected request')
  }
  class FakeDiscoveryService {
    constructor(deps) { this.deps = deps }
    async discoverModels() {
      const session = await this.deps.readSession()
      // Production service owns abandoning the old, ordinary pending choice.
      await this.deps.writeSession({ ...session, pending: { model: 'fixture-model', route: { account: 'secondary', group: 'original' }, scan: true } })
      await this.deps.fetcher(site + '/api/device/group', post(ownGroup))
      const previous = await this.deps.read(); await this.deps.write(previous, snapshot())
      await this.deps.listModels(snapshot().connections[0])
      if (externalProfileChange) await fs.writeFile(file, JSON.stringify({ ...originalProfile, externalChange: true }))
      if (serviceFails) throw new Error('SYNTHETIC_SCAN_FAILURE')
      await this.deps.fetcher(site + '/api/device/group', post({ group: 'original', expectedAccount: 'secondary', expectedGroup: 'other' }))
      const moved = await this.deps.read(); await this.deps.write(moved, snapshot())
      await this.deps.listModels(snapshot().connections[0])
      await this.deps.writeDiscovery({ version: 1, owner: ownerHash, entries: [{ account: 'secondary', group: 'other', credential: createHash('sha256').update(key).digest('hex'), at: Date.now(), models: [{ id: 'fixture-model' }] }] })
      await this.deps.writeSession({ ...session, pending: undefined })
      return { connected: true }
    }
  }
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }
  const app = { setName() {}, setPath() {}, whenReady: async () => {}, exit: value => { exitCode = value } }
  const state = vm.createContext({ __dirname: root, Buffer, Headers, URL, AbortSignal, Object, Set, Map, Date, JSON, console: { log() {} }, validateDiscoveryRequest,
    process: { argv: ['fixture', '--execute'], env: { MODMIND_LIVE_PROFILE: root, MODMIND_LIVE_SITE: site, MODMIND_DISCOVERY_REPORT: reportFile } },
    fetch: fetcher, require: name => {
      if (name === 'electron') return { app, safeStorage }
      if (name === 'node:fs/promises') return fs
      if (name === 'node:path') return path
      if (name === 'node:crypto') return { createHash, randomUUID: () => String(Math.random()).slice(2) }
      if (name === './service.cjs') return { ProviderSyncService: FakeDiscoveryService, parseProviderSnapshot: value => value, providerOwnerKey: value => createHash('sha256').update(value.siteUrl + '\0' + value.username).digest('hex'), parseModelPayload: value => value.data }
      throw new Error('unexpected module')
    } })
  try {
    await vm.runInContext(`(${discoveryHelper.toString()})()`, state)
    const reportText = await fs.readFile(reportFile, 'utf8'), report = JSON.parse(reportText)
    assert.equal(exitCode, serviceFails ? 1 : 0)
    assert.equal(report.error, serviceFails ? 'SYNTHETIC_SCAN_FAILURE' : undefined)
    assert.equal(report.inferenceRequests, 0); assert.equal(report.imageLeases, 0)
    assert.equal(reportText.includes(key), false); assert.equal(reportText.includes(token), false); assert.equal(reportText.includes(username), false)
    const posts = fakeRequests.filter(item => item.method === 'POST')
    assert.equal(posts.every(item => item.path === '/api/device/group' && !Object.hasOwn(JSON.parse(item.body), 'account')), true)
    if (!externalProfileChange) {
      assert.deepEqual(posts.map(item => JSON.parse(item.body).group), ['other', 'original'])
      assert.equal(report.restored, true); assert.equal(report.profilePersisted, true); assert.equal(currentGroup, 'original')
      const saved = JSON.parse(await fs.readFile(file, 'utf8'))
      if (nativeSnapshot) {
        const persisted = JSON.parse(Buffer.from(saved.encryptedConnections, 'base64').toString())
        assert.deepEqual(persisted.defaults, oldDefaults); assert.deepEqual(persisted.bindings, oldBindings)
        assert.equal(report.discoveryPersisted, true)
        assert.equal(JSON.parse(Buffer.from(await fs.readFile(path.join(root, 'provider-model-discovery.enc'), 'utf8'), 'base64').toString()).owner, ownerHash)
      } else assert.equal(saved.encryptedConnections, undefined)
      assert.equal(JSON.parse(Buffer.from(await fs.readFile(sessionFile, 'utf8'), 'base64').toString()).pending, undefined)
    } else {
      assert.equal(report.restoreError, 'LOCAL_PROFILE_CHANGED')
      assert.equal(report.restored, true); assert.equal(report.profilePersisted, false); assert.equal(currentGroup, 'original')
      assert.deepEqual(posts.map(item => JSON.parse(item.body).group), ['other', 'original'])
      assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).externalChange, true)
      assert.equal(JSON.parse(Buffer.from(await fs.readFile(sessionFile, 'utf8'), 'base64').toString()).pending.scan, true)
      await fs.access(path.join(root, 'single-provider-discovery-recovery.enc'))
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
