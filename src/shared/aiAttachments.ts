export const MAX_AI_ATTACHMENTS = 8
export const MAX_INLINE_ATTACHMENT_BYTES = 32 * 1024 * 1024

export type AiAttachmentSource = { path: string } | { name: string; bytes: Uint8Array }
