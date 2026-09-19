# Player testing through ModMind

The current turn's 制作功能 checklist controls access: headless requires 无头测试, rendered/capture requires 真实界面测试. If unchecked, suggest enabling the corresponding box in the professional chat composer and sending a new instruction. Do not start a different mode or native launcher to bypass this choice. Already-running sessions retain their actual mode; a session from an earlier turn does not grant access after that mode is unchecked. Stopping an owned session remains allowed for cleanup.

Use `modmind_test_session` capabilities before preparing a player test. Availability is specific to Minecraft version, Loader and the actual control JAR. A catalog entry is not a successful runtime test. Missing combinations remain unsupported; never substitute a nearby game version.

The current player session supports local plugin and modpack servers. For Java Mod projects, retain managed client/GameTest checks and use a test modpack containing the mod for automatic multiplayer interaction. Velocity requires a backend world topology and is not automatically provisioned.

- Start with mode `headless` for logic, `rendered` for a visible real client. Windows hidden rendering is not validated. Headless disables graphics; it cannot prove visuals or audio.
- Offline testing is only for the owned isolated test instance. Online mode needs the actual authenticated username. Use the managed login flow; never request credentials in chat.
- Keep the returned sessionId. Observe GUI/logs using `modmind_test_observe`; use the latest revision for clicks. A stale revision requires re-observation, not a guessed click.
- `modmind_test_action` supports only advertised commands. The pinned 1.20.1 control JAR has no key, inventory or tooltip support. General GUI click support does not establish inventory support.
- Test operator and ordinary permissions separately. Operator changes apply only to the test role and are restored at session stop. Stop the session before completing the task; disclose cleanup errors.
- A command acknowledgement is not gameplay success. `modmind_test_scenario` executes short actions with expected fresh observations, stops on failure and retains evidence. Do not retry consumption/click actions when the outcome is unknown.
- `modmind_test_capture` requires rendering and key support; it returns a new real screenshot. A screenshot alone is not a visual acceptance decision. Compare the required pose, perspective and timing; never accept blank frames or a web bot renderer as original Minecraft visuals.

Log and build evidence are in `modmind_creation_context`. Read ranges by evidence ID. Record an interaction check separately from startup/join results. If the tool cannot exercise the relevant player action, report the exact untested behavior and a short user test instead of repeatedly restarting the server.
