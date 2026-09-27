---
name: minecraft-sound-authoring
description: Create, edit, preview, and export Minecraft mod sounds through the ModMind sound workbench and its MCP tools. Use when a task involves sounds.json, OGG assets, game sound effects, music drafts, or sound validation.
---

# Minecraft Sound Authoring

Use the active project's sound workbench and shared MCP tools for sound work. Keep all sound IDs under the active project namespace unless the user explicitly asks for an event reference.

Read the current state before changing it:

- Call `modmind_sound_library` with `operation: "list"` to find events and tracks. Use `offset`/`nextOffset` for larger lists.
- Call it with `operation: "event"` to read an exact event and its current revision before editing.
- Call it with `operation: "draft"` before changing a music or effect studio draft. Preserve the returned revision when saving.
- Call it with `operation: "preview"` only for a locally available item. It does not download missing Minecraft assets.

For edits, use `modmind_sound_create`:

- `save-event` changes `sounds.json` through the same validation, conflict checks, cycle checks, and undo history used by the UI.
- `save-draft` requires the revision returned by `draft`; preserve unrelated draft fields.
- `export` renders the supplied draft and writes an OGG plus its event to the active project. Read the result and then re-list the event to verify it.
- `process` applies bounded trim, fades, gain, mono, and reverse operations to an existing audio item.
- `undo` reverts the most recent sound change. Do not claim it succeeded without reading the result.

Use the effect editor for synthesized game sounds and layered local/original sounds for composite effects. Use the music editor for multi-track, multi-bar drafts; MIDI import/export is supported, but it is not a general DAW and does not provide VST plugins or live recording.

Do not auto-download an entire Minecraft asset set. If an original sound is unavailable locally, report that the user must prepare the matching Minecraft runtime or explicitly download that individual preview in the UI.

After a write, report the event ID, changed artifact type, preview/export status, and any remaining validation or runtime testing boundary. Use `modmind_validate_content` when the task needs a project-level check.
