# Model characters

The seven WebP assets are derived from the character illustrations supplied by
the user on 2026-10-02. GPT, Gemini, Grok, GLM, Kimi, DeepSeek, and Qwen are mapped
by the emblems on the supplied images. The illustrations are preserved, with
the white background removed using border-connected pixel masking; enclosed
flat-white background gaps are cleared separately. Each asset is 840 px wide
and encoded as WebP with alpha. Total size is about 1.4 MiB.

The picker applies blur/fade to both horizontal edges. Its frame follows the
last model row's lower edge with 16 px of space below, keeping at least 560 px
for short lists, slightly longer than the previous 520 px frame. Row measurement adapts to wrapping and expanded routes
without stretching the image. As the available gap
narrows, its left mask boundary moves across the portrait, gradually fading it
out rather than toggling display. Cropped artwork fades only over the final
48–64 px. Each portrait layer independently compares its image's natural bottom
with the available frame: artwork that fits fully has no vertical mask.
The original bottom edge stays visible when the whole illustration fits.
Decorative layers sit above row separators,
ignore pointer events, and remain clear of model text and switch buttons.
Assets are bundled locally, loaded only for the selected family, and require no
external download or model-generation call.

The recommended and all-models tabs use the user-supplied `modmind-free-1790943140069.png`
illustration, processed with the same white-background masking and WebP settings.
Its horizontal whitespace is trimmed to match the other portraits' framing,
and white matte is removed from antialiased edges for dark themes.
It shares their responsive fade and has no caption beneath the artwork.

Pointer selection slides portraits horizontally by up to 8% with a 400 ms
crossfade; model rows enter from the same direction by 1.5% over 320 ms.
The family highlight follows the selected option with a 320 ms clipped-background
transition, including wrapped rows; resizing realigns it without animation.
Both reuse the shared ease-out curve. Keyboard selection is immediate, and
reduced motion removes translation and follows the app-wide reduced duration.
Only selected portraits are decoded; superseded requests are cancelled, and
outgoing layers are retired after their transition (with a 440 ms fallback).
