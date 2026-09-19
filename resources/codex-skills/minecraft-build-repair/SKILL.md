---
name: minecraft-build-repair
description: Diagnose and repair Minecraft mod Gradle, Java runtime selection, compilation, packaging, data-generation, launch, mixin, registry, dependency, and runtime failures. Use when builds fail, the game crashes, a JDK is incompatible, a mod JAR is invalid, mappings changed, dependencies conflict, or a previous repair did not resolve the same error.
---

# Minecraft Build Repair

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Find the first causal failure, repair it, and use the next run to test the diagnosis rather than repeating speculative edits.

When ModMind supplies evidence IDs, read the digest first and retrieve only relevant raw line ranges with `modmind_creation_context`. Preserve independent exceptions and the user's observed trigger. Repeated feedback after delivery is a new failure observation, not a continuation acknowledgement: compare the tested artifact with the prior hypothesis before editing again. Record the hypothesis and the check that can disprove it; compilation alone cannot establish gameplay repair.

## Workflow

1. Reproduce the smallest useful failing command and retain its complete output.
2. Classify the failure layer: toolchain, dependency resolution, Java compilation, resources/data, packaging, loader bootstrap, mixin application, registration, or gameplay runtime.
3. For compiler failures, start with the first project-owned error. For crashes, start with the deepest relevant `Caused by` and first project-owned frame.
4. Confirm the project's exact Minecraft, loader, mappings, Java, Gradle, and plugin versions.
5. Inspect the referenced API with mapping or class tools when signatures are uncertain.
6. Make the smallest coherent repair, including paired metadata/resource changes when needed.
7. Rerun the focused failing check. Escalate to a full build or Minecraft launch after the focused failure clears.
8. If the same failure remains, revise the diagnosis before changing more code.
9. Report the root cause, repair, evidence, and any environment issue that remains outside the source tree.

## Managed Diagnostic Path

- Use `modmind_test_matrix` for the smallest relevant build, client, server, or GameTest reproduction. Use `modmind_build_project` for managed artifact diagnostics and `modmind_test_minecraft` for isolated startup evidence.
- Read `modmind_runtime_state` after a managed launch to correlate the latest phase, events, timeout, and failure rather than guessing from a stale log.
- Use `modmind_mapping_search` and `modmind_mapping_class` when the first causal error is an exact-version Minecraft API mismatch.
- Route ordinary Modrinth dependencies through `modmind_dependency_search` and `modmind_dependency_install`, Maven coordinates through `modmind_maven_dependency_install`, and third-party Mod extensions through `$minecraft-addon-development`.

## Java Runtime Repair

Change Java preferences only when evidence identifies a runtime or toolchain mismatch.

1. Call `modmind_get_app_settings` and inspect separate `game`, `build`, and `tools` Java preferences.
2. Call `modmind_scan_java_homes` to discover candidates, then `modmind_probe_java_home` for the exact path under consideration.
3. Compare the probed major version with the active Minecraft, Loader, Gradle, and plugin requirements from the project and error output.
4. Call `modmind_set_app_setting` with `key: javaPreferences` and change only the affected lane. Preserve the other lane values. An empty lane restores ModMind automatic management.
5. Re-read settings and rerun the same failing managed check.

Do not set all three lanes to the newest JDK, accept an invalid probe, or claim repair before the original failure clears.

## Useful Evidence

- Gradle task and dependency reports
- Full compiler diagnostics
- Loader and mixin logs
- `latest.log`, crash report, and first project-owned stack frame
- Contents and size of the built JAR
- Loader descriptor, entrypoints, refmaps, access wideners, and generated resources
