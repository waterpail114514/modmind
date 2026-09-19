# Player-facing repairs

Read this when a requested GUI, item interaction or rendered result still differs from what the user observes.

Trace the registered item/command/network handler to the Screen or renderer actually instantiated. Multiple similarly named classes are not proof that either one is active. Confirm the loaded artifact before changing a second implementation.

For clipped or flattened images, inspect the whole constraint chain: logical viewport, GUI scale, outer container, width and height constraints, aspect ratio, compact breakpoints, clipping and transforms. Changing a maximum height cannot fix an active width constraint. Use one observation that distinguishes the suspected constraints rather than iterating arbitrary constants.

Test the affected path, including cancellation or closing when it changes input ownership. Distinguish source inspection, loading, player interaction and actual rendered evidence. Use a current screenshot with viewport/GUI scale when appearance is the issue; do not insist on screenshots for nonvisual changes.

Requirements can change: preserve the latest explicit orientation/layout choice and its source. A previous screenshot or accepted behavior is a regression reference only while still applicable. Record partial delivery for complex work with remaining behavior; an answer or compiled framework alone is not the requested playable result.
