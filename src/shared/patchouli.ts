export interface PatchouliBookInput {
  bookId: string
  name: string
  landingText: string
  locale?: string
  baseline?: string
  raw?: Record<string, unknown>
  categories: Array<{ id: string; name: string; description?: string; icon: string; raw?: Record<string, unknown>; entries: Array<{ id: string; name: string; icon: string; text: string; pages?: Array<Record<string, unknown>>; raw?: Record<string, unknown> }> }>
}
