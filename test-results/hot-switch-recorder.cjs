(async () => {
  if (globalThis.__modmindHotSwitchRecorder) return globalThis.__modmindHotSwitchRecorder.status();
  const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
  const fs = req('node:fs');
  const path = req('node:path');
  const crypto = req('node:crypto');
  const dc = req('node:diagnostics_channel');
  const { app, safeStorage, webContents } = req('electron');
  const root = path.join(app.getAppPath(), 'test-results', 'hot-switch-live-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'events.jsonl');
  const salt = crypto.randomBytes(32);
  const secrets = new Map();
  const fingerprint = (value) => crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 12);
  function secret(value, type = 'secret') {
    if (!value) return null;
    if (typeof value === 'string' && /^\[?(?:credential|code|secret):[a-f0-9]{12}\]?$/.test(value)) return value.replace(/[\[\]]/g, '');
    const tag = type + ':' + fingerprint(value);
    secrets.set(String(value), '[' + tag + ']');
    return tag;
  }
  function cleanText(value) {
    let s = String(value);
    for (const [raw, tag] of secrets) s = s.split(raw).join(tag);
    return s.replace(/\bsk-[A-Za-z0-9_-]+/g, '[API_KEY]')
      .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:code|token|key|api_key)=)[^&#\s]+/gi, '$1[REDACTED]')
      .slice(0, 131072);
  }
  function sanitize(value, key = '', depth = 0) {
    if (value == null) return value;
    if (/api.?key|authorization|password|secret|cookie|encrypted|access.?token|refresh.?token/i.test(key)) return secret(typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : JSON.stringify(value), 'credential');
    if (key === 'code' && typeof value === 'string') return secret(value, 'code');
    if (depth > 12) return '[DEPTH_LIMIT]';
    if (typeof value === 'string') return cleanText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitize(v, '', depth + 1));
    if (value instanceof Error) return { name: value.name, message: cleanText(value.message) };
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 150).map(([k, v]) => [k, sanitize(v, k, depth + 1)]));
    return String(value);
  }
  let active = true;
  let count = 0;
  let failure = null;
  const started = Date.now();
  function record(type, data) {
    if (!active) return;
    try {
      fs.appendFileSync(file, JSON.stringify({ n: ++count, time: new Date().toISOString(), elapsedMs: Date.now() - started, pid: process.pid, type, data: sanitize(data) }) + '\n');
    } catch (e) { failure = e.message; }
  }
  const credentialsPath = path.join(app.getPath('userData'), 'device-credentials.json');
  let lastSnapshot = '';
  function snapshot() {
    let state;
    try {
      const value = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      const key = safeStorage.decryptString(Buffer.from(value.encryptedApiKey, 'base64'));
      state = { baseUrl: value.baseUrl, siteUrl: value.siteUrl, keyTag: secret(key, 'credential'), connectedAt: value.connectedAt, balanceCents: value.balanceCents, usage: value.usage };
    } catch (e) { state = { unavailable: true, reason: e.code || e.name }; }
    try { state.preferences = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'beginner-ai-preferences.json'), 'utf8')); } catch {}
    const encoded = JSON.stringify(state);
    if (encoded !== lastSnapshot) { lastSnapshot = encoded; record('persisted-state', state); }
  }
  snapshot();
  const originalFetch = globalThis.fetch;
  let sequence = 0;
  function bodyData(body) {
    if (body == null) return null;
    const text = typeof body === 'string' ? body : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : null;
    if (text == null) return { bodyType: body.constructor?.name };
    try { return sanitize(JSON.parse(text)); } catch { return { bytes: Buffer.byteLength(text), text: cleanText(text) }; }
  }
  const wrappedFetch = async function(input, init) {
    const id = 'fetch-' + ++sequence;
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers || input?.headers || {}).entries());
    const startedAt = Date.now();
    record('fetch-request', { id, url, method: init?.method || input?.method || 'GET', headers, body: bodyData(init?.body) });
    try {
      const response = await Reflect.apply(originalFetch, this, [input, init]);
      record('fetch-response', { id, url, status: response.status, elapsedMs: Date.now() - startedAt, headers: Object.fromEntries(response.headers.entries()) });
      if (/\/api\/device\/|\/models?(?:[?#]|$)/.test(url)) {
        const clone = response.clone();
        void (async () => {
          const reader = clone.body?.getReader();
          if (!reader) return;
          const chunks = [];
          let bytes = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 262144) { void reader.cancel(); record('fetch-body-truncated', { id, bytes }); return; }
              chunks.push(Buffer.from(next.value));
            }
            record('fetch-response-body', { id, body: bodyData(Buffer.concat(chunks)) });
          } catch (e) { record('fetch-body-error', { id, error: e }); }
        })();
      }
      return response;
    } catch (e) {
      record('fetch-error', { id, url, elapsedMs: Date.now() - startedAt, error: e });
      throw e;
    }
  };
  globalThis.fetch = wrappedFetch;
  const requestIds = new WeakMap();
  const subscriptions = [];
  for (const name of ['undici:request:create', 'undici:request:headers', 'undici:request:trailers', 'undici:request:error']) {
    const listener = (message) => {
      try {
        const request = message.request;
        if (!request) return;
        if (!requestIds.has(request)) requestIds.set(request, 'wire-' + ++sequence);
        record(name, { id: requestIds.get(request), origin: String(request.origin), path: request.path, method: request.method, status: message.response?.statusCode, error: message.error });
      } catch (e) { record('capture-error', { source: name, error: e }); }
    };
    dc.channel(name).subscribe(listener);
    subscriptions.push([name, listener]);
  }
  const sendRestores = [];
  function hookContents(contents) {
    const original = contents.send;
    const wrapped = function(channel, ...args) {
      if (/^(device:|remote:|ai:|pipeline:|beginner-codex:)/.test(channel)) record('renderer-event', { webContentsId: contents.id, channel, args });
      return Reflect.apply(original, this, [channel, ...args]);
    };
    contents.send = wrapped;
    sendRestores.push(() => { if (!contents.isDestroyed() && contents.send === wrapped) contents.send = original; });
  }
  webContents.getAllWebContents().forEach(hookContents);
  const onCreated = (_event, contents) => hookContents(contents);
  const onSecond = (_event, argv) => record('deep-link', { links: argv.filter(v => v.startsWith('mcdev:')) });
  const onOpen = (_event, url) => record('deep-link', { url });
  app.on('web-contents-created', onCreated);
  app.on('second-instance', onSecond);
  app.on('open-url', onOpen);
  const logs = path.join(app.getPath('logs'), 'diagnostic-events.jsonl');
  let logOffset = 0;
  let remainder = '';
  function tailLog() {
    try {
      const size = fs.statSync(logs).size;
      if (size < logOffset) { logOffset = 0; remainder = ''; }
      if (size === logOffset) return;
      const start = Math.max(logOffset, size - 1048576);
      const buffer = Buffer.alloc(size - start);
      const fd = fs.openSync(logs, 'r');
      try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
      logOffset = size;
      const lines = (remainder + buffer.toString('utf8')).split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.pid === process.pid && /device|remote|ai|console|process/.test(event.subsystem)) record('application-journal', event);
        } catch {}
      }
    } catch {}
  }
  tailLog();
  const timer = setInterval(() => { snapshot(); tailLog(); }, 300);
  timer.unref();
  const status = () => ({ active, file, count, failure, elapsedMs: Date.now() - started });
  globalThis.__modmindHotSwitchRecorder = {
    status,
    stop() {
      snapshot(); tailLog(); record('capture-stopped', status()); active = false;
      clearInterval(timer);
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
      subscriptions.forEach(([name, listener]) => dc.channel(name).unsubscribe(listener));
      sendRestores.forEach(restore => restore());
      app.removeListener('web-contents-created', onCreated);
      app.removeListener('second-instance', onSecond);
      app.removeListener('open-url', onOpen);
      secrets.clear();
      return status();
    }
  };
  record('capture-started', { root, version: app.getVersion(), argv: process.argv, expectedSequence: ['supplier-1', 'free-1'], testMarker: 'HS-0909-COPPER-47', limitations: ['No pre-attachment HTTP payloads', 'Model response body not cloned; application output events captured', 'No website-browser traffic or upstream internal logs', 'State snapshots sampled every 300ms'] });
  return status();
})()
