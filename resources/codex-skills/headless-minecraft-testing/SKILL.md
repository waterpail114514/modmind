---
name: headless-minecraft-testing
description: Plan, run, or diagnose managed and external headless Minecraft Java Edition smoke tests for mods. Use when a task mentions HeadlessMC, no-display launches, ModMind isolated client/server/GameTest verification, automated Loader smoke tests, isolated game directories, process timeouts, or headless crash-log diagnosis.
---

# Headless Minecraft Testing

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Prefer ModMind's managed isolated verification when it covers the requested check. Use an external HeadlessMC workflow only for a missing capability or an explicitly external CI setup.

## Choose the path

1. Inspect the project loader, Minecraft version, Java version, test APIs, and CI environment.
2. Check whether ModMind or the repository already implements the needed headless backend and reuse it.
3. Select a build, client, server, or GameTest target that exercises the changed behavior.
4. Build the mod and inspect the produced JAR before launching when packaging is part of the diagnosis.
5. Choose authentication, game directories, artifact acquisition, timeouts, and process management appropriate to the user's environment.

Read [references/integration-assessment.md](references/integration-assessment.md) for ModMind's current runtime boundaries and possible integration points.

## ModMind Route

For an online test player, GUI/inventory interaction, permissions, or screenshot evidence, read [player-testing.md](references/player-testing.md). Probe the actual version's capabilities before starting; do not infer key or inventory support from menu support.

- Use `modmind_test_matrix` when selecting explicit build, client, server, or GameTest targets.
- Use `modmind_test_minecraft` for the managed isolated startup workflow.
- Use `modmind_test_rendered` only when 真实界面测试 is checked. Supported Java Mod versions use the pinned Minecraft Mod MCP integration, return a fresh native screenshot and GUI/player/world observations, then stop the owned client. Inspect the returned image before claiming visual correctness. Unsupported versions and modpacks retain the bounded startup-only check. Use `modmind_test_session` with `mode: rendered` for continued interaction, including native Java Mod projects; probe capabilities first and stop when done.
- Read `modmind_runtime_state` after launch, timeout, cancellation, or failure to capture current events and avoid stale conclusions.
- Invoke `$minecraft-server-pack-testing` for modpack server construction, actual HeadlessMC join verification, or bounded console scenarios. Those tools provide stronger evidence than a generic mod smoke test.

Only consider an external HeadlessMC workflow when the current environment authorizes it and no feature switch forbids it. An unchecked ModMind feature is not a missing backend to replace. Preserve actual managed failures in the report and follow ModMind's managed-process boundary.

## Capture useful evidence

- Launcher command and environment assumptions
- Minecraft, loader, Java, and mod versions
- stdout, stderr, exit code, timeout state, game log, and crash report
- Ready-line or server-ready evidence
- Deepest relevant `Caused by` entry and first project-owned stack frame

Use the evidence to repair the failure, rerun the same smoke test, and state where interactive testing remains useful for visual or player-driven behavior.
