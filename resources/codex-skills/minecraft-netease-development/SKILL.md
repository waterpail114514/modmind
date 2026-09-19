---
name: minecraft-netease-development
description: Develop, diagnose, or package NetEase Minecraft PC/mobile Python Mod SDK projects. Use for SDK events, entrypoints, persistence, UI, encoding boundaries or platform delivery; not Java/Gradle mods or trivial wording edits.
---

# NetEase Mod SDK development

In ModMind, follow the current turn's feature checklist before this workflow. A tool described here can be absent because its feature is unchecked in the professional chat composer (制作功能). Suggest checking the corresponding feature and sending a new instruction when needed; do not install replacements, use native commands, plugins, or delegation to bypass an unchecked feature. A checked but unsupported or failed capability must be reported as such, not blamed on the checkbox.

For an explicit review denial, try at most two materially different, permitted lower-risk alternatives, then stop the blocked operation and report what remains. Codex automatic approval is independently adjustable at 设置 → 执行审批 → Codex 审批模式 (default YOLO); let the user adjust it and send a new instruction when that setting is the actual blocker. Never change it yourself. YOLO does not override feature switches, read-only mode, protected files, or deterministic safety denials. An approval-service failure is distinct from a rejected operation.


Identify PC/mobile and the exact SDK from the project before choosing APIs. Java Edition, international Bedrock Script API and NetEase Python are different targets. A user's proposed API or diagnosis is a hypothesis; preserve their intended behavior while checking the implementation against the installed SDK or exact-version official documentation.

Use existing entrypoints and registered system paths. Do not rename working modules, regenerate UUIDs, or rebuild manifests for unrelated repairs. The managed inspector resolves literal RegisterSystem paths and module-level string constants; dynamic expressions may need explicit review. Inspection never executes project Python.

For lifecycle failures, follow registration → player readiness → event → state change → visible result. First join, respawn, reconnect and world teardown are distinct events. Register bound instance methods and initialize their state before callbacks can run. Check SDK signatures and Python 2 string/Unicode conversions at actual engine boundaries, rather than converting every object indiscriminately.

For chat/UI interaction, verify the exact platform capability before translating Java chat JSON or inventory screens. Keep an existing working fallback when introducing a new interaction. When only static checks are requested, respect that limit and state which behavior remains untested.

Use the managed project build for delivery. It exports behavior/resource packs with transient Python caches excluded; the project directory remains the editable engineering source. Local structure/ZIP checks do not prove MCStudio import, device behavior or online review. Preserve a supplied error and artifact identity when diagnosing external rejection; do not infer a universal packaging rule from one error code.

Choose checks matching the change. A wording edit needs relevant text/encoding checks. Event or persistence changes need the affected lifecycle scenario when a real SDK environment is available; otherwise report the smallest remaining manual check. Do not start Java/Gradle or HeadlessMC workflows for this platform.
