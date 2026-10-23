/** Merge streamed fragments without flattening the growing reply each token. */
export class ReplayTextBuffer {
  private chunks: string[]
  private length: number
  constructor(content: string) { this.chunks = content ? [content] : []; this.length = content.length }
  append(incoming: string): void {
    if (!incoming) return
    if (incoming.length >= this.length) {
      let offset = 0
      let cumulative = true
      for (const chunk of this.chunks) {
        if (!incoming.startsWith(chunk, offset)) { cumulative = false; break }
        offset += chunk.length
      }
      if (cumulative) { this.chunks = [incoming]; this.length = incoming.length; return }
    }
    if (incoming.length <= this.length) {
      let remaining = incoming.length
      let duplicate = true
      for (let index = this.chunks.length - 1; index >= 0 && remaining > 0; index--) {
        const chunk = this.chunks[index]
        const take = Math.min(chunk.length, remaining)
        if (incoming.slice(remaining - take, remaining) !== chunk.slice(chunk.length - take)) { duplicate = false; break }
        remaining -= take
      }
      if (duplicate) return
    }
    this.chunks.push(incoming)
    this.length += incoming.length
  }
  value(): string { return this.chunks.join('') }
}
