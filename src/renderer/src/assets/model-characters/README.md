# Model characters

The seven WebP assets are derived from the character illustrations supplied by
the user on 2026-10-02. GPT, Gemini, Grok, GLM, Kimi, DeepSeek, and Qwen are mapped
by the emblems on the supplied images. The illustrations are preserved, with
the white background removed using border-connected pixel masking; enclosed
flat-white background gaps are cleared separately. Each asset is 840 px wide
and encoded as WebP with alpha. Total size is about 1.4 MiB.

The picker applies blur/fade to both horizontal edges and retains a 520 px
frame for short lists, independently of model count. Long lists allow the
frame to extend up to 620 px within the list, revealing more of the original
legs without stretching the image. As the available gap
narrows, its left mask boundary moves across the portrait, gradually fading it
out rather than toggling display. Decorative layers sit above row separators,
ignore pointer events, and remain clear of model text and switch buttons.
Assets are bundled locally, loaded only for the selected family, and require no
external download or model-generation call.

The recommended tab uses the user-supplied `modmind-free-1790943140069.png`
illustration, processed with the same white-background masking and WebP settings.
Its horizontal whitespace is trimmed to match the other portraits' framing,
and white matte is removed from antialiased edges for dark themes.
It shares their responsive fade and shows “暂定，不代表最终效果” beside the artwork.

Pointer selection slides portraits horizontally by up to 8% with a 400 ms
crossfade; model rows enter from the same direction by 1.5% over 320 ms.
The family highlight follows the selected option with a 320 ms clipped-background
transition, including wrapped rows; resizing realigns it without animation.
Both reuse the shared ease-out curve. Keyboard selection is immediate, and
reduced motion removes translation and follows the app-wide reduced duration.
Only selected portraits are decoded; superseded requests are cancelled, and
outgoing layers are retired after their transition (with a 440 ms fallback).
