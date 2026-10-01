import { describe, expect, it } from 'vitest'
import { recordZipExpansion } from './archiveImportPolicy'

describe('ZIP import expansion policy', () => {
  it('allows project entry counts and sizes above the former limits', () => {
    const state = { entryCount: 0, expandedBytes: 0 }
    recordZipExpansion(state, { fileName: 'large.bin', uncompressedSize: 3 * 1024 * 1024 * 1024 })
    recordZipExpansion(state, { fileName: 'another.bin', uncompressedSize: 1024 * 1024 * 1024 })
    for (let index = 0; index < 23_801; index += 1) {
      recordZipExpansion(state, { fileName: `small-${index}.bin`, uncompressedSize: 1 })
    }
    expect(state.entryCount).toBe(23_803)
    expect(state.expandedBytes).toBe(4 * 1024 * 1024 * 1024 + 23_801)
  })

  it('keeps explicit limits for downloaded world archives', () => {
    expect(() => recordZipExpansion({ entryCount: 0, expandedBytes: 0 }, {
      fileName: 'too-large.bin',
      uncompressedSize: 256 * 1024 * 1024 + 1
    }, { maxEntryBytes: 256 * 1024 * 1024 })).toThrow('ZIP entry is too large')
    expect(() => recordZipExpansion({ entryCount: 0, expandedBytes: 2 * 1024 * 1024 * 1024 }, {
      fileName: 'extra.bin',
      uncompressedSize: 1
    }, { maxExpandedBytes: 2 * 1024 * 1024 * 1024 })).toThrow('2 GB import limit')
  })

  it('rejects unsafe size metadata and excessive entry counts', () => {
    expect(() => recordZipExpansion({ entryCount: 20_000, expandedBytes: 0 }, {
      fileName: 'extra.bin',
      uncompressedSize: 1
    }, { maxEntries: 20_000 })).toThrow('more than 20,000 entries')
    expect(() => recordZipExpansion({ entryCount: 0, expandedBytes: 0 }, {
      fileName: 'invalid.bin',
      uncompressedSize: Number.MAX_SAFE_INTEGER + 1
    })).toThrow('invalid size')
  })
})
