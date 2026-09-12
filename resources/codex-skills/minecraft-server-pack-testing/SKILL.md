---
name: minecraft-server-pack-testing
description: Build, inspect, and verify Minecraft modpack server distributions through ModMind. Use for ServerPackCreator output, dedicated-server filtering, EULA handling, loopback startup, HeadlessMC join verification, offline or authenticated server checks, console-command scenarios, log assertions, port conflicts, or reproducible server-pack acceptance.
---

# Minecraft Server Pack Testing

Produce a deterministic server pack and prove that it starts and accepts the intended client. Read [server-acceptance.md](references/server-acceptance.md) before running a join check or scenario.

## Rules

- Confirm the active project is a modpack and that its mod plan and content validation are stable before building a server derivative.
- Use `modmind_modpack_build_server`; do not assemble the initial server pack by copying client files manually.
- ModMind users explicitly accept the Minecraft EULA before acquiring the client. Reuse that prior acceptance for managed local server tests: set `acceptEula: true` when passing this option, and do not ask for another checkbox or confirmation per mode, project, or test run.
- Keep tests loopback-only. Use `onlineMode: false` for isolated automation; set it true only for an explicitly requested authenticated-server test.
- Choose a free, non-public port and keep the same output directory and port across a build/verify sequence.
- Inspect skipped client-only and unknown-side mods. Unknown-side exclusion can hide required server behavior and must be resolved before acceptance.
- A ready log line alone is insufficient when join behavior matters. Use join verification or a bounded scenario as appropriate.
- Never expose account tokens, session data, server credentials, or private download links in output.

## Workflow

### 1. Preflight

Inspect project metadata, plan/lock state, overrides, side declarations, and prior server output. Run `modmind_validate_content`. Identify the requested output directory, port, EULA state, online-mode requirement, and scenario evidence.

### 2. Build deterministically

Call `modmind_modpack_build_server`. Review the generated manifest, engine version, runtime/launch files, copied mods, skipped client mods, unknown-side exclusions, overrides, and log path.

Reject the build when a required server mod is skipped, no launch artifact is produced, or the manifest does not match the active Minecraft/Loader matrix.

### 3. Verify startup and join

Call `modmind_modpack_verify_server_join` when client compatibility or actual join success is required. Inspect server-ready evidence, HeadlessMC transcript, join evidence, timeout state, and cleanup result. Do not report success from process creation alone.

### 4. Exercise behavior

Use `modmind_modpack_run_server_scenario` for bounded console commands and log assertions. Follow the current tool schema for steps. Keep commands deterministic and assertions tied to observable server behavior. Do not use an open-ended shell or unbounded wait as a scenario step.

### 5. Close the loop

Correct pack composition, side metadata, config, port, or runtime issues and rerun the same failed check. Report the server manifest, output directory, engine/runtime, skipped mods, port and mode, ready/join/scenario evidence, logs, and remaining interactive checks.

## Completion Gate

Do not call the server pack ready when the server reports an EULA rejection, a required mod was excluded, startup timed out, the ready port was not observed, the requested join failed, an assertion failed, or cleanup left the test process active.
