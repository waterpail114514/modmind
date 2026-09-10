import fs from 'node:fs/promises';
import path from 'node:path';

const entries = await fs.readdir(new URL('./', import.meta.url));
const directory = entries.filter(name => name.startsWith('hot-switch-live-')).sort().at(-1);
if (!directory) throw new Error('No live capture exists');
const file = new URL(`./${directory}/events.jsonl`, import.meta.url);
const records = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const aliases = JSON.parse(await fs.readFile(new URL(`./${directory}/tag-aliases.json`, import.meta.url), 'utf8').catch(() => '[]'));
const canonicalTags = new Map(aliases.map(([canonical, alias]) => [alias.replace(/[\[\]]/g, ''), canonical]));
const canonicalTag = value => typeof value === 'string' ? canonicalTags.get(value.replace(/[\[\]]/g, '')) || value : value;
const requests = records.filter(row => row.type === 'fetch-request');
const responses = new Map(records.filter(row => row.type === 'fetch-response').map(row => [row.data.id, row]));
const bodies = new Map(records.filter(row => row.type === 'fetch-response-body').map(row => [row.data.id, row.data.body]));
const states = records.filter(row => row.type === 'persisted-state').map(row => ({
  time: row.time, baseUrl: row.data.baseUrl, keyTag: canonicalTag(row.data.keyTag),
  connectedAt: row.data.connectedAt, unavailable: row.data.unavailable,
  model: row.data.preferences?.current?.model,
  keyStatus: row.data.usage?.keyStatus
}));
const requestSummary = requests.map(row => {
  const response = responses.get(row.data.id);
  const body = bodies.get(row.data.id);
  return {
    time: row.time, id: row.data.id, method: row.data.method, url: row.data.url,
    credentialTag: row.data.headers?.authorization,
    model: row.data.body?.model, status: response?.data.status,
    elapsedMs: response?.data.elapsedMs,
    pollStatus: body?.data?.status,
    pollBaseUrl: body?.data?.baseUrl,
    pollCredentialTag: canonicalTag(body?.data?.apiKey),
    keyStatus: body?.data?.keyStatus,
    error: body?.error?.message || (typeof body?.error === 'string' ? body.error : undefined)
  };
});
const counts = Object.fromEntries([...new Set(records.map(row => row.type))].map(type => [type, records.filter(row => row.type === type).length]));
const deepLinks = records.filter(row => row.type === 'deep-link');
const expectedSequence = records.find(row => row.type === 'capture-started')?.data.expectedSequence || [];
const rounds = deepLinks.map((link, i) => {
  const end = deepLinks[i + 1]?.n || Infinity;
  const events = records.filter(row => row.n >= link.n && row.n < end);
  const poll = events.find(row => row.type === 'fetch-request' && row.data.url.endsWith('/api/device/poll'));
  const pollBody = bodies.get(poll?.data.id)?.data;
  const connected = events.find(row => row.type === 'renderer-event' && row.data.channel === 'device:state' && row.data.args?.[0]?.status === 'connected');
  const lastState = events.filter(row => row.type === 'persisted-state').at(-1);
  const modelsRequest = events.find(row => row.type === 'fetch-request' && row.data.url.endsWith('/models'));
  const modelsBody = bodies.get(modelsRequest?.data.id);
  const modelItems = Array.isArray(modelsBody) ? modelsBody : modelsBody?.data || modelsBody?.models || [];
  const ids = Array.isArray(modelItems) ? modelItems.map(model => typeof model === 'string' ? model : model.id || model.name) : [];
  return {
    index: i + 1, requestedLabel: expectedSequence[i] || 'unlabelled',
    deepLinkAt: link.time, connectedAt: connected?.time,
    deepLinkToConnectedMs: connected ? Date.parse(connected.time) - Date.parse(link.time) : null,
    baseUrl: pollBody?.baseUrl, keyTag: canonicalTag(pollBody?.apiKey), pollFields: Object.keys(pollBody || {}),
    finalModel: lastState?.data.preferences?.current?.model,
    availableModelCount: ids.length, availableModels: ids,
    preferenceEvents: events.filter(row => row.type === 'application-journal' && row.data.operation === 'model-preference').map(row => ({ phase: row.data.phase, message: row.data.message, data: row.data.data })),
    evidenceEventIds: events.filter(row => ['deep-link', 'fetch-response-body', 'persisted-state', 'renderer-event'].includes(row.type)).map(row => row.n)
  };
});
const report = {
  directory: path.basename(directory), rows: records.length, counts, states,
  rounds,
  requests: requestSummary,
  terminalErrors: records.filter(row => row.type === 'renderer-event' && row.data.channel === 'ai:output' && row.data.args?.[0]?.kind === 'error' && row.data.args[0].terminal === true).map(row => ({ event: row.n, time: row.time, ...row.data.args[0] })),
  recentEvents: records.filter(row => /fetch-error|capture-error|deep-link/.test(row.type)).slice(-8),
  outputChannels: [...new Set(records.filter(row => row.type === 'renderer-event').map(row => row.data.channel))],
  lastEventAt: records.at(-1)?.time
};
if (process.argv.includes('--save')) await fs.writeFile(new URL(`./${directory}/analysis.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
