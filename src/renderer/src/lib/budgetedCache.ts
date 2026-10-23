/** Small LRU for rebuildable UI data. Pending writes and user drafts stay outside it. */
export class BudgetedCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>()
  private bytes = 0
  constructor(private readonly maxBytes: number, private readonly maxEntries: number, private readonly weigh: (value: V) => number) {}
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }
  set(key: K, value: V): this {
    this.delete(key)
    const bytes = Math.max(0, this.weigh(value))
    if (bytes > this.maxBytes) return this
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value as K)
    return this
  }
  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.bytes -= entry.bytes
    return this.entries.delete(key)
  }
  clear(): void { this.entries.clear(); this.bytes = 0 }
  get size(): number { return this.entries.size }
  get retainedBytes(): number { return this.bytes }
}

/** Evict rebuildable payloads while keeping a lean copy of unsaved user work. */
export class RebuildableStateCache<K, V> {
  private readonly drafts = new Map<K, V>()
  private readonly cache: BudgetedCache<K, V>
  constructor(maxBytes: number, maxEntries: number, weigh: (value: V) => number, private readonly preserve: (value: V) => V | undefined) {
    this.cache = new BudgetedCache(maxBytes, maxEntries, weigh)
  }
  get(key: K): V | undefined { return this.cache.get(key) ?? this.drafts.get(key) }
  set(key: K, value: V): this {
    const draft = this.preserve(value)
    if (draft) this.drafts.set(key, draft)
    else this.drafts.delete(key)
    this.cache.set(key, value)
    return this
  }
  delete(key: K): void { this.drafts.delete(key); this.cache.delete(key) }
}
