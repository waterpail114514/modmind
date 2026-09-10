# Live Hot Switch Capture

- Application: running `npm run dev`, Electron main PID 30684.
- User project: testmod.
- Attached: 2026-09-09 20:07:43 Asia/Shanghai (12:07:43 UTC).
- Stopped: 2026-09-09 20:09:44 Asia/Shanghai. 152 events, 15 HTTP requests, 5 syncs; no recorder write failures.
- Cleanup completed: runtime recorder removed and temporary Node inspector closed; the application remains running.
- User-reported baseline: supplier 2.
- Requested switch order: supplier 1, supplier 2, supplier 1, free channel 1, supplier 2.
- Capture installed into the running process; application source and task state were not edited or restarted.
- Recorder stays active across agent interruptions until stopped or the app exits.
- Raw API keys, authorization codes and cookies are not written. Credential tags use a per-capture HMAC key held only in memory.
- Existing application journal entries are included with their original timestamps under `data.time`; the outer timestamp is collection time.
- Fetch request metadata and bounded sanitized bodies are recorded. Device API and model-list response bodies are cloned with a 256 KiB limit. Model response bodies are not cloned; application output events and wire completion/error events provide evidence.
- Credential and preference files are sampled every 300 ms. Faster intermediate disk states may be missed.
- Website browser traffic, upstream internal routing and child-process traffic bypassing the main-process adapter are outside this capture.
- Capture is diagnostic instrumentation, with small timing and I/O overhead. Race reproduction should later use controlled barriers.

Status: `node test-results/hot-switch-inspect.mjs status`

Summary: `node test-results/hot-switch-summary.mjs`

Stop and restore runtime hooks: `node test-results/hot-switch-inspect.mjs stop`

The attach inspector listens only on localhost. Capture stop restores fetch, event hooks, subscriptions and timers; the Node inspector is a separate debugging endpoint.

Capture note: the initial sanitizer applied HMAC tagging twice to already sanitized poll bodies. Raw `events.jsonl` is preserved. `tag-aliases.json` maps the two non-secret tag forms, recovered from the recorder's in-memory tag map without exporting keys. `analysis.json` uses canonical tags, so request authorization, poll credentials and persisted credentials can be compared. The recorder source was subsequently made idempotent for future captures.
