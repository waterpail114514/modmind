import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { validateDiscoveryRequest } from './dual-paid-live-discovery.mjs'

const site = 'https://synthetic.invalid', key = 'synthetic-model-key', token = 'synthetic-routing-token'
const policy = () => ({ site, paidAccounts: new Map([['secondary', new Set(['original', 'same-id'])], ['ls', new Set(['ls-original', 'same-id'])]]), lastRoute: { account: 'secondary', group: 'original' }, original: { account: 'secondary', group: 'original' }, bearers: new Set([key, token]), routingTokens: new Set([token]), models: new Map([[site + '/v1/models', new Set([key])]]), restoreOnly: false })
const post = (body, bearer = token) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + bearer }, body: JSON.stringify(body) })
const target = { account: 'ls', group: 'ls-original', expectedAccount: 'secondary', expectedGroup: 'original' }

test('allows advertised paid replacement with the exact current state and routing session', () => {
  assert.deepEqual(validateDiscoveryRequest(site + '/api/device/group', post(target), policy()), { method: 'POST', kind: 'group', path: '/api/device/group', account: 'ls', group: 'ls-original', expectedAccount: 'secondary', expectedGroup: 'original' })
  assert.equal(validateDiscoveryRequest(site + '/api/device/group', post({ group: 'same-id', expectedAccount: 'secondary', expectedGroup: 'original' }, key), policy()).account, 'secondary')
  assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post(target, key), policy()), /ROUTING_SESSION_REQUIRED/)
})

test('refuses stale conditions, free enrollment, unrelated fields and group IDs from a different supplier', () => {
  for (const body of [{ ...target, expectedGroup: 'stale' }, { ...target, expectedAccount: 'ls' }, { ...target, expectedGroup: undefined }, { ...target, account: 'trial:one' }, { ...target, account: 'primary' }, { ...target, group: 'original' }, { ...target, node: 'another' }]) assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post(body), policy()))
})

test('recovery mode only allows the original account and group with fresh conditions', () => {
  const p = { ...policy(), restoreOnly: true, lastRoute: { account: 'ls', group: 'ls-original' } }
  const restore = { account: 'secondary', group: 'original', expectedAccount: 'ls', expectedGroup: 'ls-original' }
  assert.equal(validateDiscoveryRequest(site + '/api/device/group', post(restore), p).account, 'secondary')
  assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post({ ...restore, group: 'same-id' }), p), /RESTORE_ONLY/)
  assert.throws(() => validateDiscoveryRequest(site + '/api/device/group', post({ ...restore, account: 'ls', group: 'ls-original' }), p), /RESTORE_ONLY/)
})

test('cannot make inference requests, obtain arbitrary endpoints, or use unrelated keys', () => {
  const p = policy(), headers = { Authorization: 'Bearer ' + key }
  assert.equal(validateDiscoveryRequest(site + '/v1/models', { headers }, p).kind, 'models')
  for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/images/generations', '/api/device/image/lease', '/api/device/providers']) assert.throws(() => validateDiscoveryRequest(site + endpoint, post({}), p))
  assert.throws(() => validateDiscoveryRequest(site + '/v1/models', { headers: { Authorization: 'Bearer unrelated-key' } }, p))
  assert.throws(() => validateDiscoveryRequest('https://elsewhere.invalid/api/device/group', post(target), p))
})

test('live verification refuses to start without explicit execution', () => {
  const result = spawnSync(process.execPath, ['scripts/dual-paid-live-discovery.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refused/)
  assert.equal(result.stdout, '')
})
