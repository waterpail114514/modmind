---
name: modmind-blockbench-modeling
description: Create, edit, texture, rig, animate, visually review, validate, save, and export production-ready Blockbench assets through the existing ModMind MCP tools. Use for Minecraft block, item, entity, Bedrock, GeckoLib-style, low-poly, reference-image, .bbmodel, UV, texture, bone, pivot, or animation work where an AI must generate or improve a model instead of merely describing one.
---

# ModMind Blockbench Modeling

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Build assets in the live ModMind Blockbench workspace and require visual evidence before delivery. Treat a structurally valid model as a candidate, not a finished asset.

Read [tool-routing.md](references/tool-routing.md) before choosing a generation path. Read [quality-gates.md](references/quality-gates.md) before the first preview and use it for every acceptance decision.

## Non-negotiable Rules

- Use the available `modmind_*` MCP tools and their current schemas as the source of truth. Do not call tools from unrelated Blockbench MCP servers or depend on arbitrary Blockbench JavaScript execution.
- Inspect `modmind_blockbench_project_state` before changing a live project. Include its `revision` as `expectedRevision` in every subsequent mutation when the tool accepts it, and refresh state after each mutation.
- Create a named `modmind_blockbench_checkpoint` before changing an existing model. Preserve the checkpoint until final verification succeeds.
- Default to production quality. Use draft quality only when the user explicitly requests a draft, prototype, or rough blockout.
- Do not deliver the first generated result. A nontrivial new model must complete at least one critique-driven geometry or appearance refinement and a second preview.
- Preview before applying. After applying, validate and visually review the live result before saving or exporting.
- Inspect the returned PNG captures themselves. JSON validity, element counts, and a numeric score cannot establish that the asset looks correct.
- Require at least front or back, side, and isometric evidence. Add top, bottom, or the opposite side when those surfaces carry meaningful geometry.
- Keep silhouette, proportions, hierarchy, pivots, UVs, texture bindings, and animation behavior intentional. Do not use random cubes, noisy pixels, or hidden details to simulate quality.
- Do not treat a concept image as a UV unwrap. Use reference silhouette extrusion only for genuinely shallow or profile-driven objects; it is not a shortcut for a full 3D subject.
- Do not save, export, or claim completion while any hard gate in `quality-gates.md` fails.
- Stop after at most three critique-driven correction rounds. If the asset still fails, leave it unsaved or restore the original checkpoint as appropriate and report the remaining defects honestly.

## Workflow

### 1. Establish the target

Determine the asset type, target format, approximate scale, texture resolution, animation needs, and delivery paths from the request and neighboring project assets. Infer conservative defaults when they do not alter compatibility. Ask only when the missing choice would materially change the format, topology, rig, or export.

Write a compact internal model brief containing:

- recognizable silhouette and focal features;
- major volumes and their relative proportions;
- symmetry or intended asymmetry;
- parent hierarchy and joint pivots;
- material palette and texture character;
- required poses, motion, and export constraints.

When a concept image is the shape reference, estimate the subject silhouette's height-to-width ratio from its visible bounds (not the full image canvas). Record that ratio in the brief; perspective can make it approximate.

### 2. Inspect and protect the workspace

Use `modmind_project_info` when project conventions matter, then use `modmind_blockbench_project_state`. For an existing model, create a checkpoint before any mutation. Record the baseline revision, counts, format, textures, hierarchy, and animations.

### 3. Choose one primary construction path

Choose the narrowest path that represents the design cleanly:

- Use Asset Intent for ordinary cuboid Minecraft models with named semantic parts.
- Use Advanced Asset for curves, wedges, cylinders, spheres, extrusions, tubes, meshes, rigs, weights, locators, IK, complex animation, or meaningful variants.
- Use Reference Asset only for a supplied image with a useful transparent silhouette that should become an editable shallow mesh.
- Use Asset Refinement for proportion, offset, rotation, inflation, or animation changes to compatible named parts in the current model.
- Use raw Blockbench actions for exact local edits, face UVs, texture assignment or painting, saving, and exporting.

Do not mix multiple full-generation paths into the same first pass. Build a coherent base, inspect it, then refine locally.

### 4. Build from large forms to small forms

Create the root hierarchy, main mass, secondary forms, and only then recognizable details. Establish front, side, and isometric silhouettes before adding surface decoration. Place origins at actual joints or attachment points, not arbitrary element centers. Use meaningful stable names so later refinement and animation can target parts reliably.

For symmetric subjects, build one consistent design language across both sides. Introduce asymmetry only when it communicates function or character. Avoid excessive element counts when fewer well-proportioned forms produce the same silhouette.

### 5. Preview and critique

Preview a temporary candidate with at least three useful views. For Advanced Asset ambiguity, provide genuinely different variants and use up to three bounded optimization iterations with `targetScore: 82`.

Critique the actual images in this order:

1. identity and silhouette;
2. proportions and balance;
3. depth, intersections, and attachment logic;
4. hierarchy and articulation readiness;
5. texture readability and material separation;
6. small details.

The first preview cannot be the final result for a nontrivial generated model. Make at least one targeted improvement justified by visible evidence, then preview again. Do not add detail merely to increase edge density or score.

### 6. Apply with revision protection

Apply only the selected candidate, using the latest revision. Re-read project state immediately afterward. Use small, attributable refinement batches; do not stack unrelated repairs into one opaque mutation.

If the result regresses or a mutation targets stale state, stop. Re-inspect or restore the checkpoint instead of applying speculative fixes.

### 7. Finish textures, rig, and animation

Finish UV and texture work only after geometry is stable. Use deterministic Blockbench texture operations for native pixel work. Use ModMind Image Studio when generated raster material is genuinely useful, inspect the image, refine it as needed, and then hand its `dataUrl` to a `create-texture` action.

Auto-unwrap meshes before painting them. Preserve semantic face assignments during UV repairs. Keep all visible UVs in bounds, use compatible atlases for single-texture formats, and check for black faces, missing bindings, bleeding, stretching, and unintended transparency.

Build the hierarchy and pivots before animation. Check key poses for detachment and intersections. For loops, verify both the motion arc and the transition from the final frame to the first.

### 8. Enforce acceptance and deliver

Run `modmind_blockbench_validate`, capture the required views, and run `modmind_asset_visual_review`. For concept-guided models, pass the brief's `referenceHeightToWidth` to the visual review and include a north or south view. Compare the concept and captures directly when perspective makes the numeric ratio uncertain. Apply every hard gate in [quality-gates.md](references/quality-gates.md). Correct failures and repeat the complete validation and visual review, up to the three-round limit.

Only after acceptance:

1. set asset metadata to `GENERATED` or `REFINED` as appropriate;
2. save the editable `.bbmodel` and all textures to project-relative paths;
3. export the target model format when requested;
4. re-read project state and confirm successful tool results;
5. create a post-acceptance checkpoint for substantial work.

Conclude with the chosen format and path, model and texture counts, views inspected, validation result, visual score and findings, corrections made, saved files, and any remaining non-blocking limitations.

## Exception for Trivial Edits

A user-requested atomic correction such as renaming one element or moving one known pivot may skip candidate generation and the mandatory refinement pass. It must still use revision protection, checkpoint an existing project, validate the live result, inspect at least the affected view, and satisfy all applicable hard gates before saving.
