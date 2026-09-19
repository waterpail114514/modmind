---
name: minecraft-version-migration
description: Migrate Minecraft Java mod source projects between game versions, mappings, Java versions, Gradle/plugin versions, or Fabric, Quilt, Forge, and NeoForge loaders. Use for source ports, Loader conversion, dependency upgrades, metadata changes, API replacements, and migration-related build or runtime failures. Use the modpack migration skill instead for a whole modpack.
---

# Minecraft Version Migration

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Treat migration as a sequence of compatibility layers so failures stay attributable.

If `modmind_project_info` reports a modpack project, stop this workflow and invoke `$minecraft-modpack-migration`.

## Workflow

1. Record the source and target matrix: Minecraft, loader, loader API, mappings, Java, Gradle, build plugin, and important dependencies.
2. Create a recoverable checkpoint and inspect current entrypoints, metadata, mixins, access rules, networking, registries, rendering, data generation, and resources.
3. Update the build toolchain and project metadata first, then resolve dependencies for the target matrix.
4. Compile to expose API changes. Use `modmind_mapping_search` and `modmind_mapping_class` for the exact target version instead of relying on similarly named APIs from another version.
5. Migrate by subsystem: initialization/registration, data components or persistence, networking, events, world generation, rendering, mixins, and data/resources.
6. Run focused checks between subsystems and use the target loader's native patterns where they simplify the result.
7. Build the distributable JAR and launch the target environment. Exercise save loading or data migration when persistent state changed.
8. Summarize behavioral differences, compatibility decisions, and anything intentionally left source-version-specific.

## Managed Migration Tools

- Use `modmind_dependency_search` and `modmind_dependency_install` for compatible Modrinth dependencies and `modmind_maven_dependency_install` for Maven coordinates.
- Invoke `$minecraft-addon-development` when another mod is an integration target rather than an ordinary library.
- Use the Java runtime procedure from `$minecraft-build-repair` when the target toolchain rejects the configured game, build, or tools JDK.
- Run `modmind_validate_content` and focused `modmind_test_matrix` targets between layers, followed by `modmind_build_project` and a target runtime launch.
- Invoke `$minecraft-release` only after migration behavior and packaging pass; a compiled port is not automatically a release candidate.

## Loader Conversion

Separate portable gameplay logic from loader integration before replacing lifecycle, event, capability/component, networking, and client registration code. Reuse a project abstraction only when it is simpler than direct target-loader APIs.
