# Renderer implementation coordination

Final integration status (2026-10-01): backend and renderer IDs are aligned,
manifests contain merged contributions, arbitrary enabled views can detach, and
the 16-plugin actual-window test has passed. The remaining notes preserve the
earlier renderer handoff rather than outstanding work. Current behavior is in
[HOST-CONTRACT.md](HOST-CONTRACT.md), with evidence in
[the verification record](../docs/feature-plugins-live-qa.zh-CN.md).

Canonical renderer IDs are `image-studio`, `item-editor`, `resource-packs`,
`sound-studio`, `model-studio`, `mappings`, `relationships`, `decompile`,
`publishing`, `versions`, and `modpack-content`.

FTB Quests, Patchouli, mod list/downloads, migration and optimization have separate
renderer bundles and IDs `ftb-quests`, `patchouli`, `modpack-mods`,
`modpack-migration`, `modpack-automation`, matching the extracted backend services.

Status: App extraction and all moved renderer sources pass web TypeScript.
Twenty-two original renderer implementation files now live beneath feature
directories. Generic loader uses manifest views/settings to resolve named exports
and optional runtime supports/keepAlive/className metadata. Each non-image
exportName defaults to its view/settings ID. Image exports remain Workspace and
Settings to match feature_host's manifest. Renderer entries need manifest views
for actual mount, so backend agent must preserve renderer-owned declarations.
SoundRenderBridge is now a generic background contribution of sound-studio,
removed from main.tsx so the core no longer imports Tone/audio production code.
The renderer SDK resolves Monaco and the theme hook from the host, avoiding
duplicate theme stores and unsupported Vite worker imports in plugin bundles.

Renderer API 2 contributions are typed in
`src/renderer/src/featurePluginTypes.ts`; generic `FeaturePageContext` carries
project/theme/account plus navigation, file changes, code editing and safe
project restoration callbacks. No Image Studio props remain in the App host.
Feature renderer SDK registers declarative pages/settings and named component
exports; manifest `views[].component` and `settings[].component` name those
exports. The existing renderer components are referenced exclusively by feature
entries, excluding them from the host renderer dependency graph. Shared server
test UI is separated from ModpackToolsWorkspace so FTB/automation is absent from
the core bundle.

Renderer does not modify preload or IPC. Backend owns actions/tools, renderer
owns views/settings descriptors. Image Studio manifest is owned by feature_host.

`renderer-contributions.json` supplies renderer-owned manifest fields for all
fifteen non-image plugins. Merge these into each manifest while preserving
backend actions/tools. Note backend main entries currently use old directory
names items/sounds/models/dependencies, while renderer follows the requested
canonical IDs item-editor/sound-studio/model-studio/relationships. Those main
directories need to be moved or their renderer IDs reconciled before bulk build.
Image Studio's settings-image category should remain ai to preserve its original
location; generic loader honors the manifest category.

Renderer page IDs are generic strings, not the legacy SidebarViewId union. Root
should extend main-process detached-window target validation to accept enabled
manifest views if arbitrary new plugin pages must support detaching.
