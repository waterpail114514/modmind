---
name: modmind-image-assets
description: Generate, inspect, reuse, and process visual assets through ModMind Image Studio for Minecraft textures, icons, promotional art, pixel refinement, reference-guided edits, or background removal. Use when an image should be created from a prompt or existing project pixels and handed into a Minecraft resource or Blockbench workflow.
---

# ModMind Image Assets

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Treat every generated or processed image as a candidate until its returned pixels are inspected.

## Tool Routing

- Read `modmind_image_studio_info` for the same saved configuration and presets used by the Image Studio UI. `includeModels: true` queries the current provider model list; lookup errors do not invalidate the saved settings. Credentials stay inside ModMind; do not read credential files or manually request image leases.
- Generation accepts `model` (this request only; otherwise the saved model), `presetId`, editable `presetPrompt`, supplemental `prompt`, `style`, `size`, `quality`, `moderation`, integer `count` (1–10), `background` (`solid`/`auto`), `backgroundColor` (`#RRGGBB`), `removeBackground`, and `referenceImage`. Presets use the same templates as the UI and reference-required presets need actual input pixels.
- `modmind_image_perfect_pixel` accepts `perfectPixel: {sampleMethod, gridSize, minSize, peakWidth, refineIntensity, fixSquare}`. Omit `gridSize` for automatic detection. Generation and processing use the same service as the UI; they do not change the user's saved credentials or default model.

- Use `modmind_image_project_assets` to discover existing project images and `modmind_image_read_project_asset` to obtain the exact `dataUrl` for a reference. Do not describe available pixels from memory.
- Use `modmind_image_generate` for generation or reference-guided editing. ModMind owns credentials, quota, billing, and provider moderation.
- Use `modmind_image_perfect_pixel` when inspected Minecraft-style output needs pixel-grid cleanup.
- Use `modmind_image_remove_background` only when the observed background should become transparent; inspect the returned edges afterward.
- Pass a final `dataUrl` to a Blockbench `create-texture` action when it belongs on a model. Invoke `$modmind-blockbench-modeling` for the geometry, UV, and visual acceptance workflow.

## Generation Rules

- Choose `style: minecraft` for textures, item icons, block art, and native pixel assets. Use `style: free` only for a requested non-Minecraft visual style.
- Use one focused prompt per distinct asset. Use `count` for comparable variants of the same brief, not unrelated deliverables.
- Include subject, view, silhouette, palette, material, pixel scale, transparency/background, and prohibited artifacts in the prompt when they matter.
- Pass an available source image as `referenceImage`. Do not substitute a prose reconstruction.
- Prefer a flat solid background when reliable removal is part of the plan.

## Acceptance Loop

1. Inspect every returned image at full size and intended Minecraft display size.
2. Compare variants for subject accuracy, silhouette, palette, material readability, edge quality, tiling or symmetry, and unwanted text or artifacts.
3. Refine only observed defects. Do not run PerfectPixel or background removal automatically when the source is already correct.
4. Re-inspect processed pixels, especially alpha edges and one-pixel features.
5. Hand off only the selected candidate and record its returned project path or data URL destination.

Reject a texture with unintended blur, anti-aliasing, palette noise, broken tile edges, illegible icon silhouette, dirty transparency, inconsistent lighting, or details below the target pixel scale.

## Blockbench and Persistence

A concept image is not a UV unwrap. Stabilize model geometry and face regions before assigning generated pixels. For cubes, entities, and animation, map face regions deliberately and retain editable `.bbmodel` sources.

The generation result may already include a project path. Processing tools return image data for handoff; do not claim a processed asset was persisted unless a subsequent supported save or model action confirms it. Save final resources under exact Minecraft namespace paths and validate their consumers.

## Reporting

Report the selected variant, style and dimensions, reference used, processing performed, visual defects checked, persisted project path or handoff target, and any remaining manual art review.
