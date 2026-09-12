---
name: minecraft-server-plugin-development
description: Develop, migrate, repair, and verify Minecraft Paper, Spigot, Folia, and Velocity server plugins. Use for plugin lifecycle, commands, permissions, scheduling, dependencies, or server memory and performance issues. Not for ModMind application extensions or Fabric/Forge mods.
---

# Minecraft server plugins

Inspect the existing build, source entrypoint, plugin.yml/paper-plugin.yml or Velocity annotation metadata before changing code. Preserve commands, permissions, configuration and stored player data. Distinguish world servers from proxies; a Velocity migration requires redesign of world operations, not just dependency replacement.

## Target and build

- Prefer the existing official/Minecraft Development starter and established platform APIs; inspect exact published API artifacts before selecting template variants. Record upstream revision and preserve license notices. Template labels such as “V2” do not identify a Velocity major version. Do not bring in static plugin singletons, old shading stacks or scheduler wrappers without a concrete need and lifecycle review.

- Resolve the exact published API, Java bytecode target, server core version/build and runtime dependencies. The API catalog proves availability only. Paper/Folia 26.x uses build-qualified coordinates; never synthesize them from the Minecraft version. Older versions are not interchangeable with the latest Javadocs.
- Use `modmind_build_project` and `modmind_local_server` for managed builds and isolated server operations. Inspect their current schemas. Do not launch unmanaged background servers or deploy into a production server for testing.
- Server APIs are compileOnly/provided. Runtime plugins go in server-plugins/ and descriptor dependency declarations; shade and relocate private libraries only when needed. Vault is an API bridge and requires the actual provider for economy scenarios.
- Preserve Gradle/Maven and lock reproducible coordinates/checksums where available. Keep build JVM, compiler target and server JVM distinct; compiling on a newer JDK does not justify raising the runtime requirement silently.
- For migration, back up data and work in an isolated copy; check API removals, serialization/config migrations and downgrade behavior before replacing the original. API availability, compilation, core readiness, plugin enablement and scenario success are separate results.

## Ownership and cleanup

Every resource introduced by the change must have an owner and a cleanup path. Apply these rules to resources the feature actually creates; do not add unused infrastructure to a starter plugin.

- Avoid static references to the plugin, Player, World, Chunk, inventories or classloaders. Cache immutable values by UUID with explicit size limits and expiry; remove session state on quit/kick and world state on unload. UUID keys alone do not bound a cache.
- Track repeating tasks, futures, subscriptions and retry timers. On disable/shutdown, stop accepting work, mark the lifecycle closed, cancel tasks and prevent in-flight callbacks from rescheduling or touching disabled plugin state. Initialization failure must close already-created resources too.
- Own and close executors, database pools, HTTP clients, watchers, streams and sockets. Use bounded queues, deadlines and bounded retries. Never block the tick/region thread with I/O, future joins or lengthy termination waits. Preserve pending data using a bounded shutdown strategy with explicit failure reporting.
- Remove owned listeners, plugin messaging channels, service registrations and external hooks when the platform does not automatically release them. Do not unregister or close another plugin's shared service. Close player interfaces and remove bossbars, scoreboards or chunk tickets owned by this feature.
- Paper/Spigot world access runs on the server thread. Folia entity and region operations must use their owning schedulers, including async completion callbacks and retired-entity handling. An ordinary global scheduler is not a safe substitute; `folia-supported: true` alone proves nothing.
- Velocity work uses proxy lifecycle/events and its scheduler. Release player session state on disconnect and plugin-owned resources at proxy shutdown. Avoid retaining connection/event objects in unbounded queues.
- Config reload must replace existing resources without duplicating tasks/listeners/pools. Do not claim Bukkit `/reload` or third-party hot-unload compatibility unless specifically implemented and tested; use normal server restarts for deployment.

## Verification

For changed runtime behavior, build and run the matching isolated core, inspect enablement errors, then exercise the affected command/event with player and console permissions and dependency absence where relevant. A ready server or a successful JAR build is insufficient evidence of plugin enablement.

For new caches, recurring work, I/O, listeners, reload behavior, or reported memory/performance problems, read [runtime-acceptance.md](references/runtime-acceptance.md) and perform the applicable checks. A text-only edit does not require soak testing.

Report what actually passed with API/core/build/Java and evidence paths. Record blocked or unrun checks explicitly. Never promise zero leaks from static review, a short run, stable RSS or successful compilation.
