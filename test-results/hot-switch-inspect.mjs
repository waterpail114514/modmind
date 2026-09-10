import fs from 'node:fs/promises';

const action = process.argv[2] || 'status';
const targets = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let rpcId = 100;
async function rpc(method, params) {
  const id = ++rpcId;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector response timeout')), 10000);
    const listener = event => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    };
    socket.addEventListener('message', listener);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
}
if (action === 'tag-aliases') {
  try {
    const fn = await rpc('Runtime.evaluate', { expression: 'globalThis.__modmindHotSwitchRecorder.status' });
    const props = await rpc('Runtime.getProperties', { objectId: fn.result.objectId, ownProperties: true });
    const scopes = props.internalProperties.find(p => p.name === '[[Scopes]]');
    const scopeList = await rpc('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true });
    let aliases = null;
    for (const scope of scopeList.result) {
      if (!scope.value?.objectId) continue;
      const variables = await rpc('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      const secrets = variables.result.find(p => p.name === 'secrets');
      if (!secrets?.value?.objectId) continue;
      const result = await rpc('Runtime.callFunctionOn', {
        objectId: secrets.value.objectId,
        functionDeclaration: 'function() { return Array.from(this).filter(([key]) => /^credential:[a-f0-9]{12}$/.test(key)); }',
        returnByValue: true
      });
      aliases = result.result.value;
      break;
    }
    const status = await rpc('Runtime.evaluate', { expression: 'globalThis.__modmindHotSwitchRecorder.status()', returnByValue: true });
    if (!Array.isArray(aliases)) throw new Error('Credential tag aliases unavailable');
    await fs.writeFile(new URL('./' + status.result.value.file.split(/[\\/]/).slice(-2, -1)[0] + '/tag-aliases.json', import.meta.url), JSON.stringify(aliases, null, 2));
    console.log(JSON.stringify({ aliases, rawSecretsExported: false }, null, 2));
  } finally { socket.close(); }
} else {
const expression = action === 'install'
  ? await fs.readFile(new URL('./hot-switch-recorder.cjs', import.meta.url), 'utf8')
  : action === 'cleanup'
    ? '(() => { if (globalThis.__modmindHotSwitchRecorder?.status().active) throw new Error("Stop recording first"); delete globalThis.__modmindHotSwitchRecorder; setTimeout(() => process.getBuiltinModule("inspector").close(), 250); return { removed: true, inspectorCloseScheduled: true }; })()'
    : action === 'stop' ? 'globalThis.__modmindHotSwitchRecorder?.stop()' : 'globalThis.__modmindHotSwitchRecorder?.status()';
const reply = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Inspector response timeout')), 10000);
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id !== 1) return;
    clearTimeout(timer);
    resolve(data);
  });
});
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
try { console.log(JSON.stringify(await reply, null, 2)); } finally { socket.close(); }
}
