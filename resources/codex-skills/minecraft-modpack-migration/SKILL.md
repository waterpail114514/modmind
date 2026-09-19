---
name: minecraft-modpack-migration
description: Assess, plan, apply, audit, and undo Minecraft modpack migrations across game versions and Fabric, Quilt, Forge, or NeoForge. Use for moving an existing pack, finding compatible files or replacements, handling missing mods and local modules, reviewing custom content, consulting MC Encyclopedia evidence, creating compatibility modules, or recovering a previous migration.
---

# Minecraft Modpack Migration

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Migrate the pack as a set of explicit decisions with recoverable state. Do not use the Java Mod source-port workflow for a whole modpack.

Read [decision-policy.md](references/decision-policy.md) before constructing apply decisions.

## Rules

- Confirm the active project is a modpack and inspect its source Minecraft version, Loader, managed mods, local modules, and custom content.
- Call `modmind_modpack_migration_targets` before choosing a target. Do not assume every Loader/version pair is supported.
- Preview before applying. Treat preview output as the authority for item IDs, candidates, source dossiers, and content status.
- Default to `backup` mode. Use `direct` only when the user explicitly requests an in-place migration and accepts the lack of one-step restoration.
- Never silently remove a missing mod. Choose `remove` only when the user accepts the lost behavior or a replacement covers it.
- Allow `defer`, but label the resulting project incomplete. Deferred work is not migration success.
- Use MC Encyclopedia tools only as read-only evidence when Modrinth and CurseForge have no adequate candidate. They do not download files or bypass captcha.
- Preserve unknown custom content for review unless the assessment proves it incompatible.
- Apply the exact reviewed arrays for mods, modules, and content. Do not invent migration IDs or candidate metadata.

## Workflow

### 1. Establish the target

Use `modmind_project_info`, inspect files, and call `modmind_modpack_migration_targets`. Record source and target Minecraft versions and Loaders, Java requirements, server expectations, and the behaviors that must survive.

### 2. Produce an assessment

Call `modmind_modpack_migration_preview`. Classify every result:

- compatible official file;
- compatible replacement;
- source port candidate;
- missing;
- unknown or requiring manual evidence.

Also review local modules, configs, scripts, datapacks, quests, resource packs, worlds, and other content. Note license, source availability, side, dependencies, and behavior changes.

Use `modmind_mcmod_search` and `modmind_mcmod_files` only for unresolved China-specific or historical projects. Record public metadata; do not claim a file was obtained.

### 3. Decide explicitly

For each mod, choose only an action supported by the current schema: use a compatible file, use a replacement, use a verified manual file, create a compatibility module, remove, or defer. For local modules, decide whether to keep, port, replace, remove, or defer as represented by the current preview. For content, preserve, adapt, remove, or defer according to its assessment.

Use exact preview identifiers and candidate data. Explain behavior loss for replacement and removal decisions before applying.

### 4. Apply recoverably

Call `modmind_modpack_migration_apply` with the target, `backup` mode by default, and the complete mod, module, and content decision arrays. Do not omit an assessed category to make the request smaller.

Inspect the returned record, report, backup availability, project status, unresolved entries, and generated compatibility modules. Do not label an `incomplete` result as complete.

### 5. Verify the migrated pack

Validate content, run relevant build/client/server checks, and inspect startup evidence. Use the server-pack workflow for server distribution. Compare key gameplay and progression behavior against the source requirements.

### 6. Audit or undo

Use `modmind_modpack_migration_history` to inspect records and undo state. Use `modmind_modpack_migration_undo` only with the intended migration ID. Confirm the result and current history afterward; ModMind snapshots the post-migration state before restoring the source backup.

Report the target matrix, decisions by category, replacements and behavior changes, deferred work, generated modules, verification, backup, migration ID, and undo availability.
