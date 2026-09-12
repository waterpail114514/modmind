# Runtime and memory acceptance

Use an isolated instance with a copied configuration and disposable player/world data. Record plugin JAR hash, API coordinate, core build/hash, Java, heap settings, dependencies and scenario. Do not inspect another application's heap or export player data for this workflow.

## Resource inventory

For each resource touched by the feature, trace acquisition, owner, limit, success/failure release and disable release. Include tasks/futures, executor queues, HTTP/SQL connections, player and world caches, listeners, subscriptions, chunk tickets, direct buffers and classloader references where present. Follow closures as well as fields. Check exceptional initialization and async callbacks completing after disconnect, world unload or shutdown.

Prefer observable assertions: active player state returns to baseline after disconnect; outstanding owned tasks reach zero after stop; pools and owned threads terminate; cache entries never exceed their configured bound. A WeakHashMap or System.gc() is not a substitute for ownership and cleanup.

## Repeatable scenario

1. Warm up the affected feature and record a stable baseline: heap used after comparable GC, class histogram, owned thread/task/connection counts, cache/queue sizes, tick time and errors. Document how each metric is obtained; unavailable instrumentation stays unverified.
2. Repeat equal workload cycles at least three times: connect/use/disconnect, create/remove entities or worlds, or reload the plugin's own config as applicable. Include I/O failure/timeout and cancellation if the feature owns async work. Allow equivalent idle/GC observation windows after each cycle.
3. Compare retained objects and owned resources after each cleanup phase. Expected bounded caches may plateau. Growing retained Player/World/plugin objects, outstanding tasks, threads or connections require investigation with class histograms and heap retaining paths, not just a heap-size adjustment.
4. Stop the server normally and verify timely exit, saved state and terminated owned workers; start again and verify data and commands. A full process restart alone cannot prove that in-process cleanup works. Do not use unsupported server hot reload as the acceptance method.

For lifecycle changes use a short repeatable regression run first. Before production readiness of persistent/high-traffic features, run an agreed 30–60 minute soak (longer for infrequent expiry cycles) at representative concurrency. If no clients, instrumentation or time window are available, record that limitation rather than substituting compilation. Capture measurements over time with the workload and timestamps; avoid an arbitrary universal memory threshold.

## Fail conditions

- Owned state fails to return to its documented baseline or bounded steady state.
- Repeated config reload duplicates tasks, listeners or pools.
- Async callbacks modify retired entities, unloaded worlds, disconnected sessions or a disabled plugin.
- Unbounded retries/queues/caches, blocking main/region threads, failed data flush, stuck shutdown, unexpected exceptions or tick-time regression.

Report separate outcomes for compilation, enablement, gameplay/permissions, shutdown and memory/performance. Limit “no leak observed” to the measured scenario and duration; retain unresolved findings as release blockers for the affected feature.
