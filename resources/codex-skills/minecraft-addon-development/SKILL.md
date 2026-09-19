---
name: minecraft-addon-development
description: Implement Minecraft Java add-ons, integrations, compatibility modules, and extensions for exact versions of third-party mods. Use when a feature depends on another mod's API, classes, registries, events, data, optional presence, local project, or user-supplied JAR and requires ModMind relationship preparation, source or artifact inspection, license-aware implementation, and synchronized testing.
---

# Minecraft Add-on Development

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Prepare exact target relationships before editing code, then implement against verified evidence. Read [relationship-policy.md](references/relationship-policy.md) before using third-party source or artifacts.

## Rules

- Call `modmind_addon_prepare` before editing when the request extends or integrates with another mod by name.
- Use `modmind_addon_import` for user-supplied project-relative JARs and accept only exact platform identity. Leave ambiguous matches for the supported user review; do not guess.
- Use `modmind_addon_link_project` for another ModMind project only when Minecraft version and Loader match.
- Call `modmind_addon_relationships` after preparation, import, or link and treat it as the authority for versions, mod IDs, paths, dependencies, sides, and licenses.
- Prefer an exact-version matched `sourcePath`. Fall back to `artifactPath` or the recorded runtime path when source is unavailable or unmatched.
- Respect source licenses. Inspection does not grant permission to copy implementation.
- Do not replace the add-on workflow with ordinary dependency installation, direct Gradle edits, downloads, or repository clones.
- Keep optional targets optional at class-load time. A missing optional mod must not crash base initialization.
- Test with the exact prepared artifacts in the synchronized ModMind instance.

## Workflow

### 1. Define relationships

Classify each target as required, optional, or test-only. Record the behavior to integrate, active Minecraft version and Loader, expected side, and whether the request concerns a platform artifact, user JAR, or local ModMind project.

### 2. Prepare targets

For named public mods, call `modmind_addon_prepare` with explicit required and optional lists and allowed providers. It resolves target files, transitive requirements, source when available, Gradle/loader metadata, and test-instance synchronization.

For supplied JARs, call `modmind_addon_import` with the correct role. For local source, call `modmind_addon_link_project` and require a successful compatible build.

### 3. Inspect exact evidence

Call `modmind_addon_relationships`. For each relationship, inspect:

- primary and alternate mod IDs;
- exact version, provider IDs, hash, side, and role;
- direct and transitive dependencies;
- public package summary and API profile;
- matched source path or artifact path;
- source license and copy constraints.

Use mappings for Minecraft APIs and exact target source or bytecode for third-party APIs. Do not rely on online snippets from a different release.

### 4. Implement isolation and compatibility

Keep integration code behind the active Loader's presence checks and lifecycle boundaries. Separate portable behavior from target-specific adapters. Avoid loading optional target classes from unconditional entrypoints, static fields, mixin configs, or shared signatures.

Update registrations, metadata, mixins, access rules, resources, and relationship declarations together. Use the target's public API when available; use reflection, access widening, or mixins only with a concrete compatibility reason and focused tests.

### 5. Verify

Build first, then run the relevant client, server, or GameTest target. Test required integrations with the target present. Test optional integrations both present and absent. Inspect generated metadata and the final artifact for correct relationship declarations.

Report exact target versions, evidence source, license decision, implementation boundary, optional-absence behavior, dependency synchronization, build/runtime evidence, and remaining compatibility assumptions.

## Completion Gate

Do not claim compatibility when preparation failed, the target version is ambiguous, source does not match the artifact, license use is unresolved, optional absence was not protected, or tests ran against a different target file.
