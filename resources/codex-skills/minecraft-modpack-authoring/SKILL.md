---
name: minecraft-modpack-authoring
description: Plan, assemble, configure, and verify Minecraft modpacks through ModMind managed tools. Use for selecting compatible mods, resolving required dependencies, applying a reviewed plan, adding verified pack content, writing FTB Quests or Patchouli guides, setting keybind presets, applying optimization profiles, or coordinating client, server, and common overrides.
---

# Minecraft Modpack Authoring

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


For verification, match the actual pack's mods, configs, scripts and resources on the test client and server. Startup and successful join do not prove progression. Select a short representative task/recipe/reward flow for changed content; do not run a full playthrough for a text-only edit. Query `modmind_test_session` capabilities before player automation. Keep test-only control mods out of exports, and report unavailable version or visual checks explicitly. Use `modmind_creation_context` for repeated failures, current constraints and evidence when available.

Build a reproducible pack from a reviewed concept. Keep mod binaries, lock data, overrides, documentation, controls, and verification consistent.

Read [content-acceptance.md](references/content-acceptance.md) before applying downloads or declaring the pack complete.

## Rules

- Confirm with `modmind_project_info` that the active project is a modpack and record its Minecraft version and Loader.
- Delegate self-authored mod implementation with `modmind_modpack_delegate_module`: first identify its namespace through `modmind_modpack_modules`, then provide concrete requirements, acceptance criteria and pack constraints. The module workbench owns Java development, dependency management and module testing in a separate context; do not load Java development skills or implement module source in the pack coordinator. Embedded and linked source projects are supported; linked work changes the original source. Review returned changes, evidence and remaining work before integrating. Do not treat an arbitrary third-party JAR as an editable source project or ask the user to repeat the request in another workbench.
- After module source changes, `modmind_build_project` builds all registered modules and syncs the resulting JARs into the pack test instance. Build failure blocks delivery; select relevant runtime verification for changed gameplay. Compilation alone does not prove pack behavior.
- Delegation returns a `taskId` immediately. Poll `modmind_modpack_module_task` with that ID and `waitSeconds: 20` until completed, failed or cancelled. Read every result before building or reporting completion. You may continue unrelated pack work while waiting; never edit/build the delegated module concurrently. Failed or cancelled tasks may have partial edits and do not imply rollback.
- Use `modmind_set_intent` for an engineering task and `modmind_update_todo` for a multi-stage pack plan so progress reflects the real workflow.
- Use ModMind managed download tools whenever they cover the requested resource. Do not replace them with browser, shell, or ad hoc downloads unless the matching tool actually fails; preserve that failure as evidence.
- Separate planning from installation. Never reconstruct or simplify a returned plan before applying it.
- Treat required, optional, and excluded mods as different commitments. A required conflict blocks application; an unresolved optional candidate must be reported, not silently promoted or dropped.
- Use `modmind_modpack_download_content` for pack content, never for mod JARs. Assign an accurate kind and client/server/common scope.
- Preserve user-authored overrides. Apply generated quests, guides, keybinds, and optimization patches through their dedicated tools instead of broad text replacement.
- Do not enable keybind conflicts unless the user explicitly accepts the exact conflicts.
- Treat optimization as a compatibility change. Apply only a named or fully declared profile and review every warning and patch path.
- Validate after each coherent content batch and before server or release work.
- Use `modmind_apply_edits` only for exact pack-owned text changes that have no dedicated structured tool; prefer the dedicated writer or download tool when one exists.

## Workflow

### 1. Translate the concept

Inspect project metadata and files. Convert the request into:

- required experiences and the mods that provide them;
- optional enhancements;
- explicit exclusions and incompatibilities;
- client-only, server-only, and common content;
- progression, documentation, controls, performance, and server requirements.

Use exact mod names when known. Do not guess project IDs or version IDs.

### 2. Plan without installing

Call `modmind_modpack_plan` with the required, optional, excluded, provider, and size constraints. Review:

- plan success;
- selected project and file for every request;
- recursively resolved dependencies;
- side compatibility;
- conflicts, warnings, substitutions, and unresolved entries;
- the proposed install review.

Revise the concept and re-plan when required entries conflict. Do not apply a failed or materially ambiguous plan.

### 3. Apply the exact reviewed plan

Pass the complete returned plan as the `plan` property to `modmind_modpack_apply_plan`. This operation downloads, verifies, installs, and hash-locks the resolved files. Confirm its installed and skipped lists and lock audit. Never call it with the original concept fields.

After application, inspect project files and run the most relevant validation. A successful download is not proof that the pack launches.

### 4. Add managed content

Use `modmind_modpack_download_content` for configs, scripts, datapacks, quests, resource packs, shader packs, UI files, worlds, or side-specific content delivered over HTTPS. Choose `extract` only for a trusted archive intended for that destination. Review returned hashes, inventory paths, and warnings.

Use `modmind_modpack_write_ftb_quest` for an FTB Quests chapter and `modmind_modpack_write_patchouli_book` for a Patchouli book. Supply complete structured content and preserve stable IDs so later updates do not duplicate progression.

Use `modmind_modpack_apply_keybinds` with conflict rejection enabled by default. If conflicts are reported, adjust the preset or ask the user to approve the exact overlap.

### 5. Apply performance policy

Use `modmind_modpack_apply_optimization_profile` only after the core plan is stable. Prefer a conservative built-in profile unless the user supplies a complete custom profile. Review resolved optional mods, excluded mods, applied config patches, and warnings. Do not equate more optimization mods with a better pack.

### 6. Verify and hand off

Run `modmind_validate_content`, then choose `modmind_test_matrix` targets that match the changes. For a distributable server, use the server-pack testing workflow. For publication, use the release workflow.

Report the applied plan, lock result, installed and skipped mods, content inventory changes, quests or guides written, keybind conflicts, optimization changes, validation evidence, and unresolved optional work.

## Completion Gate

Do not call the pack complete when the plan failed, required entries remain unresolved, lock audit failed, content validation has errors, keybind conflicts were hidden, or required client/server verification was not run. A deferred optional item is acceptable only when named explicitly.
