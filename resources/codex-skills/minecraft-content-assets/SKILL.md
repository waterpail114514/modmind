---
name: minecraft-content-assets
description: Create, integrate, and validate Minecraft mod content assets, including item and block models, textures, blockstates, entity geometry, animations, language entries, recipes, loot tables, tags, sounds, particles, and data resources. Use when a feature needs coordinated visual or data-driven content.
---

# Minecraft Content Assets

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


For large batches or mirrored data/resources, read [bulk-content.md](references/bulk-content.md). Do not load it for a single recipe, translation or asset edit.

Treat assets, data, and code references as one connected feature rather than isolated files.

## Workflow

1. Inventory every registry ID and derive the expected resource paths from the active Minecraft version and loader.
2. Inspect neighboring project assets for naming, palette, resolution, model parent, UV, and data conventions.
3. Choose the right production path: edit text formats directly, use Blockbench for models/textures, use data generators when the project supports them, or create binary assets with an appropriate native tool.
4. Build recognizable silhouettes and material detail at Minecraft's native viewing size. Check transparency, tileability, UV alignment, animation pivots, and texture references.
5. Connect blockstates, models, textures, language, recipes, loot, tags, sounds, particles, and code registrations.
6. Run `modmind_validate_content` after coherent resource batches, then inspect in game when appearance or interaction matters.
7. Keep editable source assets such as `.bbmodel` files when they will help future iteration.

## Blockbench Integration

Invoke `$modmind-blockbench-modeling` for nontrivial models, UV work, rigs, animation, reference-image geometry, or visual acceptance. Use direct `modmind_blockbench_actions` only for focused operations already covered by that tool schema.

Invoke `$modmind-image-assets` for generated textures, icons, reference images, pixel refinement, or background removal. Reuse project images through `modmind_image_project_assets` and `modmind_image_read_project_asset` instead of describing available pixels from memory.

Keep the handoff explicit: stabilize geometry, establish UV intent, inspect generated pixels, create or assign the texture, save editable sources, then validate paths and references. Use native image, audio, or filesystem tools only when ModMind lacks the required operation.

## Content Acceptance

- Require valid JSON/SNBT and resolvable model, texture, sound, animation, and tag references.
- Verify exact resource paths and namespaces against registry IDs.
- Check assets at native Minecraft viewing size, not only enlarged previews.
- Run the relevant client, server, or GameTest target when data changes behavior.
- Do not call isolated files complete until registrations and all consuming references are connected.
