const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
app.setPath('userData', path.join(process.env.APPDATA, 'modmind'));
app.whenReady().then(async () => {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'modmind', 'device-credentials.json'), 'utf8'));
    const key = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')).trim();
    const response = await fetch(stored.siteUrl.replace(/\/$/, '') + '/api/device/image-lease', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ username: stored.username, timestamp: new Date().toISOString() }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Lease HTTP ' + response.status);
    const payload = await response.json();
    const data = payload.data ?? payload;
    if (!data.baseUrl || !data.apiKey) throw new Error('Lease missing baseUrl/apiKey');
    const base = data.baseUrl.replace(/\/$/, '');
    const models = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + data.apiKey }, signal: AbortSignal.timeout(20000) });
    const list = await models.json();
    console.log(JSON.stringify({ baseUrl: base, leaseHasModel: Object.hasOwn(data, 'model'), modelsStatus: models.status, models: Array.isArray(list.data) ? list.data.map(x => x.id) : [] }));
  } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; }
  app.quit();
});
