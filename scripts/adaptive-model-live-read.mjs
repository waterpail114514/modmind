import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Read only: no session creation, group mutation, image lease or inference.
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'test-results', 'adaptive-model-routing-20261016')
const work = path.join(output, 'live-helper')
await fs.mkdir(path.join(work, 'profile'), { recursive: true })
// Windows safeStorage needs the profile's encrypted OS key. Copy only that
// encrypted key into the isolated helper profile; account files stay in place.
try {
  const profile = process.env.MODMIND_LIVE_PROFILE || path.join(process.env.APPDATA, 'modmind')
  const state = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'))
  const encryptedKeys = Object.fromEntries(Object.entries(state.os_crypt ?? {}).filter(([key, value]) => key.endsWith('encrypted_key') && typeof value === 'string'))
  if (Object.keys(encryptedKeys).length) await fs.writeFile(path.join(work, 'profile', 'Local State'), JSON.stringify({ os_crypt: encryptedKeys }))
} catch { /* The helper records unavailable credentials and probes public auth. */ }
const helper = String.raw`
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Diagnostic response validation is independent from the unmodified client's
// account whitelist. It never saves connections or sends a mutation request.
function providerOwnerKey(value) { return createHash('sha256').update(new URL(value.siteUrl).origin + '\0' + value.username).digest('hex'); }
function parseProviderSnapshot(value) {
  if (value?.protocolVersion !== 2 || !Array.isArray(value.connections) || !value.connections.length || value.connections.length > 32) throw new Error('Invalid diagnostic snapshot');
  const accounts = new Set(); let paid = 0;
  for (const connection of value.connections) {
    const valid = connection.kind === 'paid' ? ['primary','secondary','ls','deepseek'].includes(connection.account) : connection.kind === 'free' && /^trial:[a-z0-9][a-z0-9_-]{0,63}$/.test(connection.account);
    if (!valid || accounts.has(connection.account) || typeof connection.apiKey !== 'string' || !connection.apiKey.trim() || /[\r\n\0]/.test(connection.apiKey)) throw new Error('Invalid diagnostic connection');
    accounts.add(connection.account); if (connection.kind === 'paid') paid++;
    const url = new URL(connection.inferenceBaseUrl);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid diagnostic endpoint');
  }
  if (paid > 1 || !accounts.has(value.defaultAccount)) throw new Error('Invalid diagnostic provider selection');
  return value;
}
app.setName('ModMind Read-only Model Verification');
app.setPath('userData', path.join(__dirname, 'profile'));
const source = process.env.MODMIND_LIVE_PROFILE || path.join(process.env.APPDATA, 'modmind');
const reportPath = process.env.MODMIND_LIVE_REPORT;
const site = process.env.MODMIND_LIVE_SITE;
const cap = { 'X-ModMind-Sync-Capabilities': 'provider-ls' };
const report = { checkedAt: new Date().toISOString(), site, readOnly: true, authenticated: false, savedSessionUsed: false, checks: [], connections: [] };
async function get(url, bearer, label) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { ...cap, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) } });
    report.checks.push({ endpoint: label, status: response.status, authenticated: Boolean(bearer) });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, payload: payload?.data ?? payload };
  } catch (error) {
    report.checks.push({ endpoint: label, errorType: error.name, authenticated: Boolean(bearer) });
    return { ok: false, payload: null };
  }
}
async function publicChecks(reason) {
  report.reason = reason;
  await Promise.all(['/api/device/group', '/api/device/providers', '/api/device/image-provider'].map(endpoint => get(site + endpoint, null, endpoint)));
}
function safeGroups(data) {
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const groups = providers.flatMap(provider => (Array.isArray(provider.groups) ? provider.groups : []).flatMap(group => {
    if (typeof provider.account !== 'string' || typeof group.id !== 'string') return [];
    const models = Array.isArray(group.models) ? [...new Set(group.models.map(model => typeof model === 'string' ? model : model?.id).filter(model => typeof model === 'string'))] : null;
    return [{ account: provider.account, group: group.id, label: typeof group.label === 'string' ? group.label : group.id, modelCount: models?.length ?? null, models }];
  }));
  const duplicates = new Map();
  for (const group of groups) for (const model of group.models ?? []) {
    const key = group.account + '\0' + model;
    const entry = duplicates.get(key) ?? { account: group.account, model, groups: [] };
    entry.groups.push(group.group); duplicates.set(key, entry);
  }
  return { account: typeof data?.account === 'string' ? data.account : null,
    current: typeof data?.current === 'string' ? data.current : data?.current === null ? null : undefined,
    canSwitch: data?.canSwitch === true, canSwitchProvider: data?.canSwitchProvider === true,
    protocolVersion: data?.protocolVersion, groups, duplicatedModels: [...duplicates.values()].filter(entry => entry.groups.length > 1) };
}
app.whenReady().then(async () => {
  try {
    let stored;
    try { stored = JSON.parse(await fs.readFile(path.join(source, 'device-credentials.json'), 'utf8')); }
    catch { await publicChecks('No readable saved official credential profile'); return; }
    if (stored.provider === 'custom') { await publicChecks('Saved profile uses a custom API, not an official account'); return; }
    if (new URL(stored.siteUrl).origin !== site) { await publicChecks('Saved profile belongs to a different site'); return; }
    if (!safeStorage.isEncryptionAvailable()) { await publicChecks('System credential decryption is unavailable'); return; }
    let apiKey;
    try { apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim(); }
    catch { await publicChecks('Saved official credentials cannot be decrypted'); return; }
    if (!apiKey) { await publicChecks('Saved official credential is empty'); return; }
    let snapshot = null;
    if (stored.encryptedConnections) {
      try { snapshot = parseProviderSnapshot(JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedConnections, 'base64')))); report.savedProtocolVersion = 2; }
      catch { report.savedConnectionsValid = false; }
    } else report.savedProtocolVersion = 1;
    let sessionToken = null;
    try {
      const encoded = await fs.readFile(path.join(source, 'quota-routing-session.enc'), 'utf8');
      const session = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
      if (session.owner === providerOwnerKey({ siteUrl: site, username: stored.username }) && session.expiresAt > Date.now() && typeof session.token === 'string' && session.token) sessionToken = session.token;
    } catch { /* Keep all saved sessions untouched. */ }
    report.savedSessionUsed = Boolean(sessionToken);
    const bearer = sessionToken || apiKey;
    const results = await Promise.all([
      get(site + '/api/device/group', bearer, '/api/device/group'),
      get(site + '/api/device/providers' + (sessionToken ? '?credentials=1' : ''), bearer, '/api/device/providers' + (sessionToken ? '?credentials=1' : '')),
      get(site + '/api/device/image-provider', bearer, '/api/device/image-provider')
    ]);
    report.authenticated = results.some(result => result.ok);
    if (results[0].ok) report.routing = safeGroups(results[0].payload);
    if (results[1].ok && sessionToken) {
      try { snapshot = parseProviderSnapshot(results[1].payload); report.remoteProtocolVersion = 2; }
      catch { report.remoteConnectionsValid = false; }
    }
    if (results[2].ok) {
      const image = results[2].payload;
      report.image = { selection: image.selection, provider: image.provider, available: image.available, model: image.model,
        choices: Array.isArray(image.choices) ? image.choices.map(choice => ({ account: choice.account, available: choice.available })) : [] };
    }
    const connections = snapshot?.connections ?? [{ account: typeof stored.account === 'string' ? stored.account : 'legacy', kind: 'paid', group: stored.group ?? null,
      apiKey, inferenceBaseUrl: stored.baseUrl.replace(/\/$/, '') + (/\/v1\/?$/i.test(stored.baseUrl) ? '' : '/v1') }];
    await Promise.all(connections.map(async connection => {
      const url = new URL(connection.inferenceBaseUrl.replace(/\/$/, '') + '/models');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
      if (url.username || url.password || url.search || url.hash) return;
      const result = await get(url.toString(), connection.apiKey, connection.account + ' /models');
      const raw = Array.isArray(result.payload?.data) ? result.payload.data : Array.isArray(result.payload) ? result.payload : [];
      const models = raw.map(model => typeof model === 'string' ? model : model?.id).filter(model => typeof model === 'string');
      report.connections.push({ account: connection.account, kind: connection.kind, group: connection.group, modelsEndpoint: url.toString(), available: result.ok, modelCount: models.length, models });
      if (connection.kind === 'paid' && sessionToken) {
        const state = await get(site + '/api/device/group', connection.apiKey, connection.account + ' /api/device/group');
        if (state.ok) report.paidRouting = safeGroups(state.payload);
      }
    }));
    if (!report.authenticated) report.reason = 'Saved official credentials were rejected or the service was unreachable; no session was created';
  } catch (error) { report.errorType = error.name; }
  finally {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: reportPath, authenticated: report.authenticated, savedSessionUsed: report.savedSessionUsed, connectionCount: report.connections.length, checks: report.checks, ...(report.reason ? { reason: report.reason } : {}), readOnly: true }));
    app.exit(0);
  }
});
`
const helperPath = path.join(work, 'read.cjs')
await fs.writeFile(helperPath, helper)
const site = new URL(JSON.parse(await fs.readFile(path.join(root, 'resources/service-config.json'), 'utf8')).siteUrl).origin
const env = { ...process.env, MODMIND_LIVE_SITE: site, MODMIND_LIVE_REPORT: path.join(output, 'live-read.json') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['--no-error-dialogs', helperPath], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const timeout = setTimeout(() => child.kill(), 60000)
let stdout = ''
child.stdout.on('data', chunk => { stdout += String(chunk) })
child.stderr.resume()
const code = await new Promise(resolve => child.once('exit', resolve))
clearTimeout(timeout)
await fs.rm(path.join(work, 'profile', 'Local State'), { force: true })
console.log(stdout.trim())
process.exitCode = code ?? 1
