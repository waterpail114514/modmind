# Blockbench Production Quality Gates

Apply these gates to every generated model. Default to the production tier unless the user explicitly requests a draft.

## Quality tiers

### Draft

Allow a rough blockout only when explicitly requested. Require a readable silhouette, correct format, named major parts, valid geometry, and no broken references. Label it as a draft and do not present it as final art.

### Production

Require all hard gates below, a visual review score of at least 82, two reviewed previews for nontrivial generation, and saved editable sources. This is the default tier.

### Hero

Require production acceptance plus deliberate secondary forms, controlled asymmetry where appropriate, stronger material separation, clean close and distant reads, and additional views or animation poses covering every important feature.

## Hard gates

Fail acceptance when any applicable gate fails, regardless of the total visual score.

### Intent and identity

- The asset matches the requested subject, target format, and project conventions.
- The subject remains recognizable at thumbnail scale in at least one orthographic view and one isometric view.
- The focal feature is visible and supported by the silhouette instead of explained only by texture noise.
- Every major part has a functional, anatomical, or stylistic purpose. Remove meaningless cubes and hidden decorative geometry.

### Proportion and depth

- Major masses have an intentional size hierarchy and a stable visual center of gravity.
- Front, side, and isometric views describe the same coherent object.
- Thin parts have enough thickness for the target format and viewing distance.
- Attachments meet their hosts convincingly. Reject accidental gaps, floating parts, implausible tangencies, and intersections visible in normal poses.
- Repetition uses consistent spacing, scale, and orientation unless variation is deliberate.

### Geometry and hierarchy

- Validation reports no errors.
- Reject zero-volume cubes, degenerate faces, invalid bounds, duplicate coincident surfaces, unintended internal geometry, and details that are fully occluded.
- Use the simplest topology that preserves the intended silhouette. Do not increase element count to imitate sophistication.
- Names are meaningful and unique enough for later editing.
- Parent-child relationships reflect how the object should move or be maintained.
- Origins and pivots sit at real joints, hinges, or attachment points.
- Symmetry is geometrically consistent unless documented design intent requires asymmetry.

### UV and texture

- Every intended visible face resolves to a valid texture and an in-bounds UV region.
- Reject black fallback faces, missing textures, accidental uniform first-texture binding, stretching, bleeding, mirrored text, and unexplained transparency.
- Preserve pixel scale and texel density across related parts.
- Use a controlled palette with enough value or hue separation to reveal major forms. Do not use random pixel noise as detail.
- Keep geometry seams and texture seams in low-attention locations when possible.
- Use a single compatible atlas when the target format requires a single texture or persistent Box UV behavior.
- A generated image may provide source pixels or a reference, but it does not count as a valid UV layout by itself.

### Rig and animation

- Bones and groups form a valid hierarchy with intentional pivots.
- Weighted vertices resolve to the expected bones and do not detach in representative poses.
- Locators and IK targets have clear semantic purposes and stable parents.
- Key poses preserve the silhouette and avoid visible self-intersection, detached parts, and excessive deformation.
- A loop returns cleanly from its final frame to its first; keyframe existence alone is not acceptance.
- Review the animation from at least one silhouette-revealing and one depth-revealing view.

### Reference fidelity

- Match the reference's defining proportions, silhouette, palette, and feature placement without inventing contradictory forms.
- For concept-guided models, compare the subject's approximate silhouette height-to-width ratio with a front model capture. Treat a `reference-proportion-mismatch` finding as a failed gate, and inspect both images directly before accepting a perspective-heavy reference.
- Document reasonable assumptions for unseen surfaces rather than copying the visible side onto every direction.
- Reject a shallow silhouette extrusion when the reference clearly describes a volumetric subject.

### Evidence and persistence

- Inspect at least three captures: north or south, east or west, and an isometric view. Add views for important unseen surfaces.
- Clear framing must show the whole model without important parts touching image boundaries.
- Re-run validation and visual review after the final mutation; earlier evidence is stale.
- Confirm successful save results for the `.bbmodel`, required textures, and requested export. Do not infer persistence from the live editor state.
- Keep the original checkpoint until all final evidence passes.

## Numeric visual review gate

For production work, require:

- overall score at least 82;
- no `error` finding;
- clipping risk no greater than 0.08;
- occupancy between 0.14 and 0.70;
- contrast at least 0.20;
- edge density at least 0.015, without adding meaningless detail to reach it;
- view consistency at least 0.55.

Treat symmetry below 0.62 as a problem only when the design brief calls for symmetry. Treat a passing score as necessary but insufficient: reject obvious subject mismatch, bad proportions, broken UVs, or unappealing silhouettes even at 82 or above.

## Required correction loop

For a nontrivial generated model:

1. Capture the first preview and list concrete visible defects.
2. Change geometry, proportions, hierarchy, or appearance in response to those defects.
3. Capture a second preview and compare it with the first.
4. Apply the best candidate, validate the live state, and run the numeric visual review.
5. Correct remaining hard-gate failures and repeat complete evidence collection.

Perform at most three correction rounds. Do not weaken the tier, lower the score threshold, crop away defects, omit bad views, or add irrelevant detail to force a pass.

## Failure contract

When the three-round limit is exhausted:

- do not save or export a failing new asset;
- restore the original checkpoint when existing work was degraded;
- state that production acceptance was not reached;
- report the exact failed gates, last score, views inspected, and the reference or design decision needed for another attempt;
- never use phrases such as "completed" or "production-ready" for the failed result.
