# Experience design and interaction acceptance

Separate the experience goal from a proposed technique. When a version/API cannot implement the technique, compare a small number of alternatives by visible result, dependencies and the user's constraints. An earlier prohibition may be superseded only by a later explicit user change. Record current constraints and their source message with `modmind_creation_context` when available.

For uncertain visual/player behavior, prove a minimal vertical slice: trigger, core effect, cleanup. Preserve a user-approved result as a baseline. Do not silently replace a full player visual with a poorer approximation to resolve an unrelated exception.

Repeated failures need a discriminating next observation. Record the prior hypothesis, changed version, current observation and what would falsify the hypothesis. For an accessory failure distinguish: event not received, accessory identity rejected, wrong config loaded, Lore mismatch, target rejected, event cancelled, or inventory writeback not applied. Do not keep changing Lore normalization without checking the earlier gates.

Choose only the checks relevant to the change:

- Inventory: valid and invalid targets, empty slots, stacked items, normal and creative mode, cancellation, exactly-one consumption, no duplication or disappearance. Prepare items through console commands when useful, but exercise actual player clicks for acceptance.
- Visuals: first person, third person or an observer as required, direction, high-speed following, equipment and termination. No-render headless tests cannot validate these.
- Lifecycle: disconnect, collision/interruption and normal stop for owned state. Keep unrelated existing permissions and integrations intact.

Use player testing only when capabilities support the target. A successful server boot and `plugins` output are startup evidence; neither proves gameplay. Runtime faults outside the plugin still belong in the evidence, not in speculative source edits.
