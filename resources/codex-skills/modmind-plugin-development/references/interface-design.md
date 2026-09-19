# ModMind plugin interface design

Use for ModMind panel and overlay UI. Honor an explicitly requested visual identity; keep theme support, readable controls, and predictable interactions. Pure backend tools need no UI.

## Default interface

ModMind gives working content a quiet frame. Use neutral surfaces, compact typography, fine separators, and space to express hierarchy. The theme's action color identifies the primary action; gold/detail is a small accent, not body text. Avoid turning every piece of information into a raised card or adding a second app sidebar inside the plugin.

Start from `modmind_plugins_scaffold`, then read the generated HTML before editing. It contains portable CSS and `window.ModMindUI`; no npm dependency, CDN, or main-application DOM access is needed. Preserve these foundations while replacing the example content. Older plugins may not contain them: retain their behavior and explicitly adapt the existing theme handler rather than assuming the helper exists.

Available classes (use semantic HTML):

| Class | Use |
| --- | --- |
| `mm-page`, `mm-toolbar`, `mm-heading`, `mm-content` | Main page, compact wrapping toolbar, title/context, work area |
| `mm-actions`, `mm-primary`, `mm-quiet` | Action group, primary button, low-emphasis button |
| `mm-section`, `mm-list`, `mm-row` | Sections and definition-list rows separated by fine rules |
| `mm-form`, `mm-field`, `mm-description` | Form with visible labels, inputs, help text |
| `mm-details` | Native `details`/`summary` for secondary information |
| `mm-empty`, `mm-status` | Useful empty state and inline progress/result feedback |

Keep a clear primary action per active task. Put infrequent actions and raw diagnostics behind details or a menu. Display human-readable results before raw JSON. Describe the user's action in labels; bridge, permission, and MCP terminology belongs in developer details.

Keep editing in its current context, with a visible source/back path and consistent save behavior. Do not require a directory tree or multiple tabs for a simple task. Preserve drafts and selections across theme changes. Advanced settings should not be a prerequisite for common work.

## Theme and bridge contract

The iframe does not inherit host CSS. On `hostInfo`, read `data.hostInfo`; on `themeChanged`, read `data`. Apply `palette` CSS variables and `scrollbarStyle`, set `color-scheme` from `theme`, and accept messages only when `event.source === window.parent`. Do not reload the document to change themes.

Use `--theme-canvas`, `--theme-panel`, `--theme-surface`, `--theme-raised`, `--theme-text`, `--theme-muted`, `--theme-line`, `--theme-action`, `--theme-on-action`, `--theme-accent`, `--theme-focus`, and semantic success/warning/danger tokens. The generated fallback colors come from the same host theme source; do not replace them with a personal light/dark palette. Artwork, game textures, and data colors may retain their own palette; separate them from UI chrome. Pet overlays keep transparent backgrounds.

The generated `window.ModMindUI` exposes:

- `request(payload)`: host request/result correlation with a 35-second timeout; rejects on failure. It does not extend the host's operation timeout or cancel the underlying operation. After a timeout on a write operation, reconcile its state before offering a retry.
- `setStatus(element, state, message)`: updates inline feedback (`loading`, `empty`, `success`, `error`); errors use `role=alert`.
- `hostInfo`: most recent initial host information. `modmind:hostinfo` fires when it arrives. Theme updates only repaint the interface.

Disable only the affected action while pending, expose busy state, retain entered content after failure, and restore controls in `finally`. Show an actionable retry or recovery path. Use actual result data, not fabricated progress or success.

## Interface acceptance

For new UI or structural changes, verify the actual plugin in its sandbox:

1. Light, dark, another preset, and custom host colors update the page and controls without losing drafts or selection.
2. At 320 px and desktop widths, long names and paths wrap, buttons remain reachable, and the document has no unintended horizontal scrolling. A small pet window should fit its declared minimum size.
3. Tab navigation has visible focus, labels name controls, Enter/Space activate native controls, and details can be expanded from the keyboard.
4. No project/no data, pending, success, error, and retry states are understandable. Repeated clicks during a pending operation do not submit twice.
5. Motion serves feedback; avoid decorative entrance sequences and respect reduced motion. Hover-only information must also be available to keyboard/touch users.

For small copy changes, check the affected state only. If runtime access is unavailable, report which checks were not run. Reload success alone is not visual acceptance.

Repository maintainers: `npm run plugins:generate` synchronizes distributable templates; `npm run plugins:check` checks drift and basic visual rules; `npm run plugins:smoke` exercises templates in actual Electron plugin iframes. These repository checks do not certify arbitrary third-party plugins.
