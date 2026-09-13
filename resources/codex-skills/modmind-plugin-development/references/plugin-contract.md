# ModMind Plugin Contract

## Manifest

- ID: 3-64 lowercase letters, digits, or hyphens; no leading or trailing hyphen.
- Version: semantic version.
- Relative entry paths only; no traversal, drive, or absolute paths.
- Declare at least one backend, panel, or overlay surface.
- Backend tool names use lowercase letters, digits, underscores, or hyphens and must be unique.

Current host permissions are `project.read`, `storage`, `net.fetch`, `clipboard.write`, `ui.overlay`, `chat.read`, `chat.write`, and `chat.context`. Request only those used by the implementation.

## Panel and overlay bridge

Panels send `ready`, `invokeTool`, `getProjectInfo`, `netFetch`, `copyToClipboard`, `context`, or `log` messages through the host contract. Correlate calls with unique request IDs and handle `ok: false` results. The panel CSP prevents direct network connections; use host-mediated `netFetch` with permission.

`context` messages use `{ type: 'context', requestId, op, args }`. With `ui.overlay`, use `overlayGetState`, `overlayClose`, `overlayShow`, `overlayPopOut`, `overlayDock`, or `overlaySetAlwaysOnTop` (`{ alwaysOnTop }`). These control only the calling plugin. Closing hides the overlay; docking returns it to the app. Users can restore it from the manager.

With `chat.read`, use `chatGetCurrent` to read the main window's current workbench conversation (`projectPath`, `conversationId`, `title`, `busy`, `draft`, `messages`). With `chat.write`, use `chatSetDraft` (`{ text, mode?: 'append' | 'replace', target? }`), defaulting to append without sending. With `chat.context`, use `chatSetContext` (`{ key, text, target? }`) and `chatRemoveContext` (`{ key, target? }`). Backend equivalents are `ctx.overlay.getState/close/show/popOut/dock/setAlwaysOnTop`, `ctx.chat.getCurrent(target?)`, `ctx.chat.setDraft(text, options?)`, `ctx.chat.setContext(key, text, target?)`, and `ctx.chat.removeContext(key, target?)`.

Pass `{ projectPath, conversationId }` as `target` after asynchronous work; stale targets are rejected. Context is scoped to plugin, project, conversation, and key. It is attached as attributed reference material on future new workbench AI requests, including native-session fallback, without native memory files, automatic sending, or mid-turn injection. It does not affect inspiration or recovery runs. Removing context does not erase already sent model history. Context is in-memory and cleared on plugin disable/removal/reload or app exit. Limits: 32000 characters per entry, 64000 total per conversation, 100 entries per plugin, 1-80 ASCII word/dot/hyphen characters per key. Backends remain lazily activated; panels can call these operations directly without a backend.

Never render unsanitized external HTML. Keep layout usable in both themes and handle a missing active project.

## Backend

Register exactly the handlers declared by `backend.tools`. Validate input again inside handlers even when JSON Schema exists. Return serializable values and bounded errors. Avoid logging secrets or complete environment data.

The backend is trusted Node code, not an OS sandbox. Host permissions do not restrict direct Node APIs, so authority must also be controlled by implementation review.

## Dynamic MCP tools

The public name is `modmind_plugin_<plugin-id>_<tool-name>`. Read-only annotations determine availability in read-only sessions. After reload, MCP clients discover the latest descriptors on `tools/list` without restarting the MCP server. Verify both descriptor refresh and tool execution.
