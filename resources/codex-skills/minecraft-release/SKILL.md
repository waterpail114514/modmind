---
name: minecraft-release
description: Prepare and verify releases for Minecraft Java mods, modpacks, and supported add-on archives. Use for release candidates, version and changelog readiness, license and metadata checks, fresh JAR or .mrpack artifacts, dependency relationships, build and test gates, Modrinth, CurseForge, or GitHub release preparation, or diagnosing a failed ModMind release preflight.
---

# Minecraft Release

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Prove that the exact artifact is current, structurally valid, documented, and tested before any publication. Read [release-gates.md](references/release-gates.md) before declaring readiness.

## Rules

- Treat release preparation and publication as separate actions. `modmind_release_preflight` does not publish anything.
- Do not change a version, channel, changelog, project ID, or repository target without user intent or established project policy.
- Keep credentials in the ModMind host. Never read, write, echo, or request publication tokens in project files or task output.
- Build from the current source before final preflight. Reject stale artifacts.
- Use managed content validation and test tools instead of relying on compilation alone.
- Require every preflight failure to be fixed. Treat license and changelog warnings as release blockers unless the user explicitly accepts a justified exception.
- Inspect the exact artifact path and size returned by preflight. Do not select a similarly named older file.
- For add-ons, ensure published relationships use exact prepared target metadata and legal dependency declarations.
- Never claim a release was published unless an authorized publication operation returns provider evidence. No MCP publication tool means hand off after readiness.

## Workflow

### 1. Freeze the candidate

Inspect project metadata and files. Record project kind, Loader/platform, Minecraft version, release version, channel, changelog, license, destination IDs, dependency relationships, and expected artifact type.

Stop unrelated feature work. If source changes after a build, rebuild before preflight.

### 2. Validate source and content

Run `modmind_validate_content`. Resolve malformed JSON, missing sounds, or resource references. Use `modmind_test_matrix` for the smallest relevant build/client/server/GameTest set, then run `modmind_build_project` for a current distributable Java artifact when applicable.

For modpacks, ensure the plan lock, managed content inventory, local modules, and overrides are stable. For server deliverables, complete the server-pack testing workflow separately.

### 3. Run release preflight

Call `modmind_release_preflight`. Review every check, not only `ready`:

- artifact existence, structure, freshness, type, and size;
- version validity;
- Loader descriptor or pack manifest;
- license;
- changelog;
- platform limitations and dependency relationships.

For a modpack, preflight may materialize the current `.mrpack` candidate locally. This is artifact creation, not publication.

### 4. Repair and repeat

Fix failed or unaccepted warning checks, rerun the relevant build/test step, then rerun preflight. Do not suppress a check or reuse pre-change results.

### 5. Hand off or publish through an authorized surface

When preflight passes all required gates, report the exact artifact, checksum when available, version/channel, destinations, validation, tests, and preflight checks. If publication is requested but no authorized publication tool is available, stop at a ready artifact and state that publication remains pending in ModMind's release surface.

## Completion Gate

Do not call a candidate release-ready when its artifact is missing, malformed, stale, untested, version-mismatched, missing required metadata, or tied to unresolved dependencies. Do not call it published without provider-confirmed IDs or URLs from an authorized operation.
