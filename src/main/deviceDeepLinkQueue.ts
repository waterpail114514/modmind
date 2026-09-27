import { createHash } from 'node:crypto'

/** Bounded, serial queue; retain cold-start links until IPC and the window are ready. */
export class DeviceDeepLinkQueue {
  private pending: string[] = []
  private recent = new Map<string, number>()
  private ready = false
  private draining = false
  constructor(private readonly handle: (url: string) => Promise<void>) {}
  enqueue(url: string): void {
    if (!url.startsWith('mcdev://') || url.length > 16384) return
    const now = Date.now()
    for (const [key, time] of this.recent) if (now - time > 60_000) this.recent.delete(key)
    const digest = createHash('sha256').update(url).digest('hex')
    if (this.recent.has(digest) || this.pending.length >= 16) return
    this.recent.set(digest, now)
    if (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!)
    this.pending.push(url)
    void this.drain()
  }
  setReady(): void { this.ready = true; void this.drain() }
  private async drain(): Promise<void> {
    if (!this.ready || this.draining) return
    this.draining = true
    try {
      while (this.pending.length) {
        try { await this.handle(this.pending.shift()!) }
        catch { console.error('[device-deep-link] Authorization could not be completed') }
      }
    }
    finally { this.draining = false }
  }
}
