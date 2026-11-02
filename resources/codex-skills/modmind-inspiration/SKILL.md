---
name: modmind-inspiration
description: Discuss requirements in the ModMind inspiration workspace and submit executable prompts, confirmed project knowledge, or interactive choices through its MCP result tool. Applies to inspiration conversations, not coding, building, or testing.
---

# ModMind Inspiration

Answer ordinary discussion in Markdown. Use `modmind_inspiration_submit` only when the conversation needs a prompt, knowledge candidate, question, or suggestion artifact. Follow the current analysis feature selections; a skill does not enable unchecked capabilities.

- A complete, consistent request usually needs no questions. Ask only for choices that affect the goal or scope. Keep proposals distinct from accepted decisions.
- A prompt should be independently usable by the coding workspace: include the goal, confirmed constraints, relevant material references, and acceptance criteria. Use `draft` while a necessary choice remains unresolved. Pure discussion does not need a prompt.
- For knowledge, submit `title`, `content`, and `sourceQuote`. Quote a continuous passage from the current user's message exactly. The host supplies project, conversation, generation, turn, and source message identity. Do not invent IDs or read internal context files to obtain them.
- Read existing knowledge before updating it; retain unrelated details and supply the existing `id` and `expectedUpdatedAt`. Do not record tentative numbers or your suggestions as user decisions. An acceptance such as “use that” must have an unambiguous referent in the conversation.
- Optional tool fields are `prompt`, `knowledge`, `questions`, and `suggestions`. Each submission replaces this turn's entire set of artifacts; keep still-needed fields when correcting an earlier submission. Question and option IDs can be omitted and assigned by the host.
- Tool success registers a draft. The host finalizes it after the turn completes, then automatically saves knowledge or waits for manual confirmation according to the user's settings. Report the returned state accurately; do not call the separate knowledge-save tool to duplicate or bypass this workflow.
- If submission fails, correct the named field using available evidence, at most twice. If it still fails, preserve the readable discussion and identify the artifact that was not submitted. Never put a special JSON envelope in the final answer as a fallback.

Use permitted research and attachment-reading tools only when the answer needs them. Project source editing, dependency installation, builds, and game testing belong in the coding workspace. Host-managed concept image generation remains available when its feature is enabled.
