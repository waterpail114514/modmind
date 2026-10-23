import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const output = process.env.MODMIND_SERVICE_READ_OUTPUT
  ? path.resolve(process.env.MODMIND_SERVICE_READ_OUTPUT)
  : path.join(root, 'test-results', 'adaptive-model-implementation-20261017')
const work = path.join(output, 'live-service-helper')
await fs.mkdir(path.join(work, 'profile'), { recursive: true })
const profile = process.env.MODMIND_LIVE_PROFILE || path.join(process.env.APPDATA, 'modmind')
try {
  const state = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'))
  const encrypted = Object.fromEntries(Object.entries(state.os_crypt ?? {}).filter(([key, value]) => key.endsWith('encrypted_key') && typeof value === 'string'))
  if (Object.keys(encrypted).length) await fs.writeFile(path.join(work, 'profile', 'Local State'), JSON.stringify({ os_crypt: encrypted }))
} catch { /* The helper reports unavailable system credentials. */ }
await build({ stdin: { contents: "export { ProviderSyncService, parseProviderSnapshot, providerOwnerKey } from './src/main/providerSync'; export { parseModelPayload, queryDeviceImageProvider } from './src/main/deviceIntegration';", resolveDir: root, loader: 'ts' }, outfile: path.join(work, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
const helper = String.raw`
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises'); const path = require('node:path');
const { ProviderSyncService, parseProviderSnapshot, providerOwnerKey, parseModelPayload, queryDeviceImageProvider } = require('./service.cjs');
app.setName('ModMind Read-only Production Service Verification');
app.setPath('userData', path.join(__dirname, 'profile'));
const report = { checkedAt: new Date().toISOString(), service: 'ProviderSyncService', readOnly: true, productionProfileWrites: 0, writesAttempted: 0, inMemorySnapshotUpdates: 0, checks: [] };
const site = process.env.MODMIND_SERVICE_READ_SITE, source = process.env.MODMIND_SERVICE_READ_PROFILE;
const cap = { 'X-ModMind-Sync-Version': '2', 'X-ModMind-Sync-Capabilities': 'provider-ls' };
async function readonlyFetch(url, init = {}) {
  if (init.method && init.method !== 'GET') { report.writesAttempted++; throw new Error('Read-only verifier forbids non-GET requests'); }
  const response = await fetch(url, { ...init, method: 'GET', redirect: 'error', signal: init.signal || AbortSignal.timeout(12000) });
  const parsed = new URL(String(url));
  report.checks.push({ host: parsed.host, path: parsed.pathname + parsed.search, method: 'GET', status: response.status });
  if (parsed.pathname === '/api/device/group') {
    const payload = await response.clone().json().catch(() => ({}));
    const data = payload.data || {};
    (report.directoryReads ||= []).push({ success: payload.success, account: data.account, provider: data.provider, current: typeof data.current === 'string' ? data.current : typeof data.current, group: typeof data.group === 'string' ? data.group : typeof data.group });
  }
  return response;
}
app.whenReady().then(async () => {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(source, 'device-credentials.json'), 'utf8'));
    if (stored.provider === 'custom' || new URL(stored.siteUrl).origin !== site || !safeStorage.isEncryptionAvailable()) throw new Error('Official saved profile unavailable');
    const apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim();
    let session = null;
    try {
      const saved = JSON.parse(safeStorage.decryptString(Buffer.from(await fs.readFile(path.join(source, 'quota-routing-session.enc'), 'utf8'), 'base64')));
      if (saved.owner === providerOwnerKey({ siteUrl: site, username: stored.username }) && saved.expiresAt > Date.now() && typeof saved.token === 'string' && saved.token) session = saved;
    } catch { /* Never create a new session for a read-only verification. */ }
    if (session) {
      const listingResponse = await readonlyFetch(site + '/api/device/providers', { headers: { ...cap, Authorization: 'Bearer ' + session.token } });
      if (listingResponse.ok) {
        const listing = (await listingResponse.json()).data || {};
        const paid = listing.paid && typeof listing.paid === 'object' ? listing.paid : {};
        report.v2ProviderSelection = { protocolVersion: listing.protocolVersion, phase: typeof listing.phase === 'string' ? listing.phase : undefined, defaultAccount: listing.defaultAccount, accounts: Array.isArray(listing.accounts) ? listing.accounts.map(a => typeof a === 'string' ? a : a.account) : [], paid: { account: paid.account, phase: paid.phase, status: paid.status }, choices: Array.isArray(listing.choices) ? listing.choices.map(p => ({ account: p.account, label: p.label, kind: p.kind, ...(typeof p.selected === 'boolean' ? { selected: p.selected } : {}), ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}) })) : [] };
      }
    }
    let snapshot;
    if (session) {
      const response = await readonlyFetch(site + '/api/device/providers?credentials=1', { headers: { ...cap, Authorization: 'Bearer ' + session.token } });
      if (!response.ok) throw new Error('Saved routing session was rejected');
      const payload = await response.json();
      if (payload.success !== true || (payload.data?.username !== undefined && payload.data.username !== stored.username)) throw new Error('Official snapshot identity mismatch');
      snapshot = parseProviderSnapshot(payload.data);
    } else if (stored.encryptedConnections) snapshot = parseProviderSnapshot(JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedConnections, 'base64'))));
    else throw new Error('No valid saved routing session or native snapshot');
    report.defaultAccount = snapshot.defaultAccount;
    report.connections = snapshot.connections.map(c => ({ account: c.account, label: c.label, kind: c.kind, group: c.group, declaredModelCount: c.models?.length ?? null }));
    const directoryResponse = await readonlyFetch(site + '/api/device/group', { headers: { ...cap, Authorization: 'Bearer ' + (session?.token || apiKey) } });
    if (directoryResponse.ok) {
      const directory = (await directoryResponse.json()).data;
      const groups = items => Array.isArray(items) ? items.map(g => ({ id: g.id, label: g.label, ...(Array.isArray(g.models) ? { models: g.models } : {}) })) : [];
      report.advertisedDirectory = { account: directory.account, current: directory.current, canSwitch: directory.canSwitch === true, canSwitchProvider: directory.canSwitchProvider === true, ...(directory.protocolVersion !== undefined ? { protocolVersion: directory.protocolVersion } : {}), multiProviderSyncRequired: directory.multiProviderSyncRequired === true, routingSessionRequired: directory.routingSessionRequired === true, groups: groups(directory.groups), providers: Array.isArray(directory.providers) ? directory.providers.map(p => ({ account: p.account, label: p.label, kind: p.kind, groups: groups(p.groups) })) : [] };
    }
    const savedPreferences = JSON.parse(await fs.readFile(path.join(source, 'beginner-ai-preferences.json'), 'utf8').catch(() => '{}'));
    const rawPreferences = savedPreferences.current || savedPreferences;
    const defaults = snapshot.connections.find(c => c.account === snapshot.defaultAccount);
    const preferences = { model: typeof rawPreferences.model === 'string' ? rawPreferences.model : defaults.model || '', account: snapshot.defaultAccount, billing: defaults.kind === 'free' ? 'free' : 'quota', reasoningLevel: 'auto', fastMode: false, ...(defaults.kind === 'paid' && defaults.group ? { group: defaults.group } : {}) };
    const owner = { siteUrl: site, username: stored.username, sync: snapshot };
    const noWrite = async () => { report.writesAttempted++; throw new Error('Read-only verifier forbids persistence'); };
    const service = new ProviderSyncService({ read: async () => owner, write: async (_previous, next) => { owner.sync = next; report.inMemorySnapshotUpdates++; }, readSession: async () => session, writeSession: noWrite, readPreferences: async () => preferences, applyDefaults: noWrite, paidBusy: () => false,
      readDiscovery: async () => { try { return JSON.parse(safeStorage.decryptString(Buffer.from(await fs.readFile(path.join(source, 'provider-model-discovery.enc'), 'utf8'), 'base64'))); } catch { return null; } },
      fetcher: readonlyFetch, listModels: async connection => {
        const response = await readonlyFetch(connection.inferenceBaseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + connection.apiKey } });
        if (!response.ok) throw new Error('Actual model endpoint unavailable');
        return parseModelPayload(await response.json());
      } });
    report.stage = 'catalog';
    const [catalog, duplicate] = await Promise.all([service.catalog(false), service.catalog(false)]);
    report.catalog = { connected: catalog.connected, stale: catalog.stale, protocolVersion: catalog.protocolVersion, currentRoute: catalog.currentRoute, modelOptionCount: catalog.models.length, availableOptionCount: catalog.models.filter(m => m.available).length, verifiedOptionCount: catalog.models.filter(m => m.modelEvidence === 'verified').length, unknownOptionCount: catalog.models.filter(m => m.modelEvidence === 'unknown').length, freeOptionCount: catalog.models.filter(m => m.billing === 'free').length,
      providers: catalog.providers, routes: catalog.routes, recoveryRequired: catalog.recoveryRequired, duplicateConcurrentReadMatches: duplicate.models.length === catalog.models.length };
    const current = catalog.models.filter(m => m.account === defaults.account && (defaults.kind === 'free' || m.group === defaults.group) && m.modelEvidence === 'verified' && m.available);
    report.currentVerifiedModels = current.map(m => m.id);
    const chosen = current.find(m => m.id === preferences.model) || current[0];
    if (chosen && !catalog.recoveryRequired) {
      report.stage = 'resolve';
      const resolved = await service.resolve({ model: chosen.id, reasoningLevel: 'auto', account: chosen.account, billing: chosen.billing, ...(typeof chosen.group === 'string' ? { group: chosen.group } : {}) });
      report.resolved = { account: resolved.connection.account, group: resolved.connection.group, model: resolved.model, inferenceHost: new URL(resolved.connection.inferenceBaseUrl).host };
      report.sampleModelRoutes = catalog.models.filter(m => m.id === chosen.id).map(m => ({ account: m.account, group: m.group, groupLabel: m.groupLabel, available: m.available, modelEvidence: m.modelEvidence }));
    } else if (catalog.recoveryRequired) report.skippedResolve = 'Saved earlier model switch requires confirmation; read-only verification preserves it';
    if (process.env.MODMIND_SERVICE_READ_TRY_SELECTIONS === '1' && !catalog.recoveryRequired && chosen) {
      report.stage = 'v2-production-selection';
      report.selectionBindingIsolation = 'in-memory only; real preferences and credential files are untouched';
      report.selectionAttempts = [];
      const targets = report.advertisedDirectory?.providers || [];
      for (const target of targets) {
        const before = structuredClone(owner.sync);
        const connection = before.connections.find(c => c.account === target.account);
        const actual = connection && catalog.models.find(m => m.account === connection.account && m.available && m.modelEvidence === 'verified' && (connection.kind === 'free' || m.group === connection.group));
        const model = actual?.id || (target.kind === 'free' ? 'deepseek-v4.1-flash' : chosen.id);
        const attempt = { account: target.account, label: target.label, kind: target.kind, connected: Boolean(connection), model };
        try {
          const result = await service.select(model, { account: target.account, billing: target.kind === 'free' ? 'free' : 'quota', ...(connection?.kind === 'paid' && connection.group ? { group: connection.group } : {}), scope: 'workspace' });
          attempt.status = result.status; attempt.selection = result.selection; attempt.message = result.message;
          if (result.status === 'ok') {
            const resolved = await service.resolve(result.selection);
            attempt.resolved = { account: resolved.connection.account, group: resolved.connection.group, model: resolved.model };
          }
        } catch (error) { attempt.status = 'rejected'; attempt.message = String(error.message).split(apiKey).join('[redacted]').split(session?.token || '\0').join('[redacted]').split(stored.username).join('[redacted]'); }
        finally { owner.sync = before; }
        report.selectionAttempts.push(attempt);
      }
      const afterResponse = await readonlyFetch(site + '/api/device/providers?credentials=1', { headers: { ...cap, Authorization: 'Bearer ' + session.token } });
      if (!afterResponse.ok) throw new Error('Final v2 state read failed');
      const afterEnvelope = await afterResponse.json();
      const after = parseProviderSnapshot(afterEnvelope.data);
      const beforePaid = snapshot.connections.find(c => c.kind === 'paid'), afterPaid = after.connections.find(c => c.kind === 'paid');
      report.remoteStateUnchanged = beforePaid?.account === afterPaid?.account && beforePaid?.group === afterPaid?.group && snapshot.defaultAccount === after.defaultAccount && JSON.stringify(snapshot.connections.map(c => c.account)) === JSON.stringify(after.connections.map(c => c.account));
    }
    report.stage = 'image-metadata';
    const image = await queryDeviceImageProvider(site, session?.token || apiKey, AbortSignal.timeout(12000), readonlyFetch);
    report.image = { selection: image.selection, provider: image.provider, available: image.available, model: image.model };
    report.authenticated = true;
    report.inferenceRequests = 0; report.imageLeases = 0; report.remoteMutations = 0;
  } catch (error) { report.errorType = error.name; report.errorSummary = String(error.message).replace(/[^\p{Script=Han}\s，。、；：（）！？]/gu, '').slice(0, 160); report.authenticated = false; }
  finally {
    await fs.writeFile(process.env.MODMIND_SERVICE_READ_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: process.env.MODMIND_SERVICE_READ_REPORT, authenticated: report.authenticated, writesAttempted: report.writesAttempted, modelOptions: report.catalog?.modelOptionCount, verified: report.catalog?.verifiedOptionCount, unknown: report.catalog?.unknownOptionCount, free: report.catalog?.freeOptionCount, ...(report.selectionAttempts ? { selectionAttempts: report.selectionAttempts, remoteStateUnchanged: report.remoteStateUnchanged } : {}), checks: report.checks }));
    app.exit(report.authenticated && !report.writesAttempted ? 0 : 1);
  }
});
`
await fs.writeFile(path.join(work, 'read.cjs'), helper)
const site = new URL(JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8')).siteUrl).origin
const env = { ...process.env, MODMIND_SERVICE_READ_SITE: site, MODMIND_SERVICE_READ_PROFILE: profile, MODMIND_SERVICE_READ_REPORT: path.join(output, 'live-service-read.json') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--no-error-dialogs', path.join(work, 'read.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const timeout = setTimeout(() => child.kill(), 60000)
let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.resume()
const code = await new Promise(resolve => child.once('exit', resolve))
clearTimeout(timeout)
await fs.rm(path.join(work, 'profile', 'Local State'), { force: true })
console.log(stdout.trim()); process.exitCode = code ?? 1
