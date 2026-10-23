# Native Feature Plugin API 2

Developer entry: [mmfeature and mmstudio](../docs/extensions-development.zh-CN.md).
Step-by-step guides: [feature packages](../docs/mmfeature-development.zh-CN.md)
and [studio packages](../docs/mmstudio-development.zh-CN.md).

`src/shared/featurePlugins.ts` is the canonical typed contract. These trusted
native application features are separate from the iframe third-party plugin
system. The loader accepts only `format: "modmind-feature"`, `apiVersion: 2`, and
the exact `hostVersion: "1.5.0-plugintest"`. This is the protocol identifier used
by the published main application `1.5.0-preview.3`; feature releases keep it
unchanged and use three numeric components in their own `version` field.
API 1 packages are rejected; an old package must be rebuilt against API 2.

## Manifest And Contributions

A manifest declares its ID, display name, version, entry names, SHA-256 `files`
map, and optional `dependencies`, `hostCapabilities`, `assets`, and contribution
arrays:

- `studios`: domain API 1 definitions for project creation/adoption, dual AI profiles,
  skills and task bindings; see `src/shared/studios.ts` and `studioSchema.ts`.
- `capabilities`: `{ id, name, description }`, including installable capabilities.
- `views`: `{ id, label, component, icon, group?, order?, loaders? }`.
- `settings`: `{ id, label, component, category, keywords? }`; categories are
  `general`, `ai`, `development`, `integrations`, and `about`.
- `actions`: `{ id, handler, inputSchema, permission, projectRequired?, surfaces?, inspirationOutput? }`.
- `tools`: `{ name, action, description }`, with a `modmind_` tool name referring
  to an action declared by the same plugin.
- `events`: unique declared event names.

Manifests, views, settings and actions may declare `studioIds` and `loaders`.
Package and contribution scopes are checked together; `studioIds` contains domain
IDs, not package IDs. An action with `studioIds` must require a project. Tool
discovery filters by project, and invocation rechecks the active domain.

Action permissions are `read`, `write`, `network`, or `process`; surfaces are
`workbench` and `inspiration`. Omitting `surfaces` makes an action eligible for
either surface, subject to the host's additional restrictions. View `component`
and settings `component` name exports in
`window.__modmindRegisterFeature(id, { ...exports })`. Renderer metadata may
also provide page lifecycle options, launcher actions, and background components
through `FeatureRendererModule` in `src/renderer/src/featurePluginTypes.ts`.

## Discovery And Invocation

`list()` / `discoverInstalled()` return installed records with a manifest
definition excluding the `files` hashes. `catalog()` merges the built-in or
host-provided metadata catalog with installed manifests and returns `installed`,
`enabled`, `available`, `state`, and `installHint`. States are `not-installed`,
`disabled`, `ready`, `error`, and `dependency-missing`. Metadata does not load
optional business code. An available record is eligible for lazy activation;
it does not prove that account credentials, an online service, or every task is
currently usable.

`snapshot()` returns a process-local monotonic `revision` and the catalog.
`tools(surface)` returns declared tools only for available plugins and supported
surfaces, adding `pluginId`, `inputSchema`, `permission`, `projectRequired`, and
`inspirationOutput`. The workbench bridge further applies the user's selected
features, read-only rules, and approval policy. Knowing that a capability is
installable never authorizes calling an absent plugin.

`invoke(pluginId, actionId, input, context)` clones and validates the input with
Ajv, checks plugin availability, read-only mode, surface, required project, and
current project identity, then calls the optional host authorization hook. It
checks the project again after authorization before invoking the declared
handler. Input JSON is limited to 32 MiB; compiled schema caching is bounded to
256 entries. Unknown schema keywords fail compilation. `format` annotations are
not validated, and schema defaults do not automatically modify the input.

The invocation context may carry `projectPath`, `readOnly`, `surface`,
`allowInspirationOutput`, `signal`, and `windowId`. Cancellation is passed to
the plugin; a handler must cooperate with its signal. MCP calls use the existing
ModMind action review before generic dispatch. `service<T>(id)` remains an
internal typed bridge for shared business services, not a schema-validated
alternative AI tool endpoint.

## Activation And Shared Runtime

`main.cjs` exports synchronous `activate(options)`, returning a service object
with optional `actions`, `dispose()`, and `projectChanged(projectPath)`.
`actions[].handler` names an entry in `runtime.actions` or a service method.
Every declared handler must exist at activation. Direct service methods and
nested action handles are guarded against use after deactivation.

Object-shaped host options are augmented with `pluginId`, `pluginDirectory`,
`assetBaseUrl`, and `emitEvent`. `@modmind/host` resolves to host capabilities;
declared `hostCapabilities` must be present. Relative and absolute `require`
requests resolve with a plugin-local Node require, while bare package requests
resolve from the host installation. `require.resolve`, `cache`, `extensions`,
and `main` are available. This is native code with application privileges,
not a sandbox; capability declarations do not restrict arbitrary Node access.

The build replaces imports of shared main-process facilities with
`require('@modmind/host').runtime.<module>` shims. The canonical module list is
in `scripts/build-feature-plugins.mjs` and `src/main/featureHostRuntime.ts`.
Diagnostics, downloads, metadata caches, project mutation protection, networking,
process trees, and native feature routing therefore reuse host instances instead
of creating separate plugin instances. `buildRuntime` and `creationFeedbackService`
also share core build behavior and evidence; optional testing subclasses the core
builder instead of duplicating it. The `testingV1` capability is required by the
testing feature and its ServerPackCreator runtime, so earlier hosts reject these
packages even if their version string matches. `activeService(id)` inspects an
already active service without loading optional code. The renderer similarly shares React,
ReactDOM, JSX runtime, dialogs, theme, MiniPaint, and the host code editor.

Testing 1.0.2 also requires `testingV2`: shared proxy routing and download recovery,
scenario JAR selection IPC, and operation-aware read-only scenario queries.
Earlier hosts reject this package instead of invoking missing host interfaces.

Shader testing 1.1.0 uses the isolated session lifecycle already shipped in
`1.5.0-preview.3`. Publishing a feature package does not update the main
application or establish real Minecraft/Iris validation.

## Events And Assets

`emitEvent(name, value, windowId?)` accepts only declared event names and a JSON
payload of at most 1 MiB. The host forwards events to authorized main/detached
windows, optionally restricted by window ID. Renderer subscribers use
`featurePlugins.onEvent(id, name, callback)` and its unsubscribe function.
Inactive, changing, or stale runtimes cannot emit events.

The fixed entries are `main.cjs`, `renderer.js`, and `renderer.css`. Additional
regular files live under `assets/` and must appear in the hash map. Packages are
limited to 64 MiB compressed and 128 MiB unpacked, with at most 512 hashed
files. Path traversal, duplicate/case-colliding names, links, and unsupported
paths are rejected. Installed files are rechecked on initialization; executable
entry and served resource hashes are checked again when used.

`modmind-feature://<id>/` serves verified `renderer.js`, `renderer.css`, and
declared `assets/` files only for available plugins. It does not expose
`main.cjs` or `manifest.json`. Assets are public plugin resources and must not
contain credentials. Source `assets` mappings are build-time group-to-repository
paths copied to `assets/<group>/`; `assetBaseUrl` points to that runtime root.

## Lifecycle And Project Changes

Installation validates the complete package, writes a staging directory, and
renames it into place. Enabled state persists via a `disabled` marker. Duplicate
view/settings/tool contributions and cyclic dependencies are rejected. Missing
dependencies make a plugin unavailable; removing an enabled dependency requires
first disabling its dependents.

Install, enable/disable, and uninstall refuse changes while a plugin call or
host-reported workbench task is running. Deactivation invalidates the emitter,
awaits `dispose()`, removes runtime/service handles, and clears plugin-local
Node require cache entries. Uninstall removes the plugin directory; data stored
in project or application data directories is not deleted by the loader.

The host calls `projectChanged(pathOrNull)` on instantiated runtimes when the
active project changes. Plugin hooks must release project-specific resources;
the loader does not infer their cleanup requirements. Renderer routes are keyed
by project unless their page declares application scope. Host shutdown stops its
tasks and calls `shutdown()`, which blocks further use and attempts disposal of
all instantiated runtimes even if one disposal fails.

## Inspiration Output Boundary

Read-only invocations normally allow only `read` actions. The service makes a
limited exception when the action declares `inspirationOutput: true`, the surface
is `inspiration`, and the host sets `allowInspirationOutput: true`. A plugin flag
alone cannot grant permission. The current bridge permits this exception only
for the three Image Studio generation/processing tools while the user has enabled
image generation; ordinary writes, settings changes, and process execution
remain unavailable in that surface.

Image generation writes new artifacts under
`<project.toolDataDirectory or .modmind>/image-studio/generated/`, verifies the
project and canonical output directory, and returns actual artifact paths.
Processing returns image data rather than overwriting project resources.
Integrating an image into resources is a separate explicit operation. The generic
loader does not impose an arbitrary plugin filesystem sandbox; enforcing each
output path is the business handler's responsibility.

## Build Outputs

Each source directory contains `manifest.json`, `main.ts`, and `renderer.ts` or
`renderer.tsx`, with optional `main-contributions.json` and asset mappings.
Build-only `nativeBinaries` maps logical names to npm packages exporting native
executable paths. The builder copies each executable and upstream notices into
`assets/native/`, adds a hash index and a runtime `target: { platform, arch }`,
and removes build-only package declarations. The loader rejects mismatched
targets. R7 uses this for the optional media runtime shared by sound/publishing.
Build-only `assetFiles` limits an asset group to explicit files, excluding partial
downloads and temporary folders. `assetChunks` maps a logical name to a source,
byte offset, and length; each bounded slice is written to `assets/chunks/<name>.part`
and hashed like other assets. Source paths and ranges are validated. Both fields
are removed from the runtime manifest. ServerPackCreator uses two dependency
packages to retain the 64 MiB archive limit; its runtime assembles and verifies
the original upstream JAR before use.
The builder merges backend action/tool contributions and rejects duplicate
identifiers. It bundles each feature independently, shares the runtimes above,
emits empty CSS when needed, includes upstream notices, and hashes every runtime
file. `--only=<id>` limits compilation to one feature.

Outputs are `feature-plugin-dist/<id>/`, `feature-plugin-dist/<id>.mmfeature`
(or `<id>.mmstudio` when `studios` is nonempty),
and `feature-plugin-dist/catalog.json`. The metadata-only
`src/shared/featurePluginCatalog.json` is regenerated from source manifests and
exported by `src/shared/featurePluginCatalog.ts`. The build-input report stays
outside the archive. This build creates no application installer and does not
write new packages into the historical `release` directory.
