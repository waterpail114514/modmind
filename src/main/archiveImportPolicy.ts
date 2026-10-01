export interface ZipExpansionState {
  entryCount: number
  expandedBytes: number
}

export interface ZipExpansionEntry {
  fileName: string
  uncompressedSize: number
}

export interface ZipExpansionLimits {
  maxEntries?: number
  maxEntryBytes?: number
  maxExpandedBytes?: number
}

export function recordZipExpansion(state: ZipExpansionState, entry: ZipExpansionEntry, limits: ZipExpansionLimits = {}): void {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(state.expandedBytes + entry.uncompressedSize) ||
      !Number.isSafeInteger(state.entryCount + 1)) {
    throw new Error(`ZIP entry has an invalid size: ${entry.fileName}`)
  }
  state.entryCount += 1
  state.expandedBytes += entry.uncompressedSize
  if (limits.maxEntries !== undefined && state.entryCount > limits.maxEntries) throw new Error(`ZIP archive contains more than ${limits.maxEntries.toLocaleString('en-US')} entries`)
  if (limits.maxEntryBytes !== undefined && entry.uncompressedSize > limits.maxEntryBytes) throw new Error(`ZIP entry is too large: ${entry.fileName}`)
  if (limits.maxExpandedBytes !== undefined && state.expandedBytes > limits.maxExpandedBytes) throw new Error('ZIP expanded size exceeds the 2 GB import limit')
}
