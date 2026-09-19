# Performance design and evidence

Performance means delivering correct behavior within response-time and resource budgets on a specified server and workload, including concurrent use and sustained operation. It covers tick/region execution time, interaction latency, CPU, retained memory and allocation/GC pressure, disk/network traffic, and how these grow with load.

## Scope the cost before writing the hot path

Use the known core/build, Java, hardware/heap, dependencies and target workload. Identify active players, entities/regions, simultaneous effects, observers, trigger frequency and data size only where relevant. If target scale is unknown, state assumptions and proceed with bounded defaults; ask only when the missing value changes the design materially. Do not invent a supported player count.

For the changed path, identify its trigger, frequency, thread, candidate count, expensive operation and cleanup owner. Estimate total work as frequency × active instances × work per instance; include recipient count for effects. A small per-player loop nested inside a whole-server player loop may grow quadratically. Keep this reasoning proportional to the feature rather than producing a formal report for every edit.

Standard world servers target 20 TPS, giving about 50 ms per tick for the entire server workload, not a per-plugin allowance. TPS alone hides diminishing headroom and occasional stalls. Use tick-duration distributions and workload context. On Folia examine affected regions/entity schedulers; on Velocity use event/command latency, throughput and queues rather than imposing a world-server tick metric.

Choose budgets from the target workload, existing baseline and user requirements. If useful, propose provisional budgets and label them as assumptions. Never present a universal per-plugin millisecond or memory threshold as a platform guarantee.

## Choose an implementation with bounded work

| Changed behavior | Design decisions |
| --- | --- |
| Movement, combat or other frequent events | Reject irrelevant events early using cheap checks. Avoid repeated config parsing, regex compilation, serialization and external lookups in the hot path. Skip unchanged position/cell/state only when that preserves the feature's actual trigger semantics. |
| Player/entity/region searches | Query relevant worlds, nearby candidates or a maintained index before expensive checks. Bound radius and candidates where semantics permit. Do not scan every world, load/generate chunks, or compare every player with every other player on each tick without a demonstrated need and budget. |
| Repeating work and bulk edits | Run only while needed; choose cadence from required responsiveness. Bound work per tick/batch and outstanding work, with a defined overload policy. Splitting a full scan across ticks smooths a spike but does not reduce total cost; ensure updates are not lost or endlessly delayed. |
| Disk, database and HTTP | Keep blocking I/O and future joins off tick/region threads and latency-sensitive proxy handlers. Use bounded workers/queues, deadlines and retries. Batch or cache only with explicit ordering, invalidation and durability semantics; do not acknowledge a durable reward or purchase before its required commit. |
| Async computation | Transfer immutable snapshots or thread-safe values to workers. Apply results on the platform's owning thread/scheduler and recheck session, entity, lifecycle and data version. Moving unsafe Bukkit/world access to an async task is not an optimization. |
| Particles, fake entities, menus and packets | Send to relevant observers and update changed state; account for active effects × observers × update frequency. Bound effect lifetime and owned entities/tasks. Preserve required visibility and motion fidelity; lowering quality or dropping effects is a product tradeoff, not an invisible fix. |
| Caches and logging | Bound size/lifetime, define invalidation and avoid retaining live player/world objects. Avoid per-event log spam and expensive formatting when logging is disabled; retain actionable error evidence. Use the parent skill's ownership rules for cleanup. |

Prefer event-driven updates when they cover the required transitions; bounded polling can be correct when no reliable event exists. Do not impose a new scheduler framework, cache layer or dependency on a simple feature without a concrete benefit. Rate limits, delayed updates or rejected work must have defined behavior and preserve the requested gameplay/data guarantees.

## Validate at the level of the claim

- For new runtime code, review the changed hot paths and perform the relevant functional checks. Exercise concurrency when introducing shared state or async work. An optimization must preserve results, permissions, ordering and cleanup.
- For a performance fix or a throughput/capacity claim, compare the baseline and changed JAR under the same core, dependencies, configuration, world, hardware/heap and workload after warm-up. Use comparable observation windows and repeat noisy comparisons. Record JAR identity, workload, duration, collection method and evidence paths.
- Cover idle behavior, representative concurrent use and a relevant burst. Select metrics that expose the suspected cost: tick or response-time median/p95/p99 and spikes, profiler hotspots, CPU, allocation/GC, post-GC retained heap, queue/cache/task counts, I/O or packets per second. Only report percentiles supported by enough actual samples; record counts and sampling windows. A low average can hide stalls.
- Use an available profiler such as spark or JFR only after checking the target runtime/tool capabilities. Match hotspots to the changed plugin path; whole-server MSPT includes other plugins, world simulation and GC. Do not attribute the full server cost to this plugin or claim improvement from an uncontrolled before/after run.
- For lifecycle, memory growth or sustained workload concerns, follow [runtime-acceptance.md](runtime-acceptance.md). A short benchmark cannot establish leak freedom or long-term stability. Monitor server cost separately from client rendering or network latency when diagnosing perceived lag.
- Use isolated managed test instances. Missing clients, profiler access or a representative workload limits the claim; it does not justify stress-testing a live server or inventing measurements. Static review, compilation, enablement, functional testing and measured performance are distinct evidence levels.

Report the relevant cost avoided or measured change, the tested workload, any behavior tradeoff, and remaining limits. If no representative performance run was possible, say that the implementation was reviewed for bounded cost and performance remains unverified. Do not claim “high performance,” a supported player count or a percentage improvement from compilation or a single-player smoke test.
