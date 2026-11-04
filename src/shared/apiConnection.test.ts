import { describe, expect, it } from 'vitest'
import { ensureOpenAiV1Base, hasApiVersionPath, normalizeAiApiBase, sameApiBaseUrl } from './apiConnection'

describe('AI API base normalization', () => {
  it('canonicalizes a base without inventing a version segment', () => {
    expect(normalizeAiApiBase('https://provider.test/v1/')).toBe('https://provider.test/v1')
    expect(normalizeAiApiBase(' https://provider.test/api?key=secret#frag ')).toBe('https://provider.test/api')
    expect(normalizeAiApiBase('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234')
  })

  it('rejects non-HTTP bases and embedded credentials', () => {
    expect(() => normalizeAiApiBase('ftp://provider.test')).toThrow('must use HTTP or HTTPS')
    expect(() => normalizeAiApiBase('https://user:pass@provider.test')).toThrow('cannot contain credentials')
    expect(() => normalizeAiApiBase('not a url')).toThrow()
  })

  it('detects an existing version segment case-insensitively', () => {
    expect(hasApiVersionPath('https://provider.test/v1')).toBe(true)
    expect(hasApiVersionPath('https://provider.test/V1/')).toBe(true)
    expect(hasApiVersionPath('https://provider.test/api/v2')).toBe(true)
    expect(hasApiVersionPath('https://provider.test/v1beta')).toBe(true)
    expect(hasApiVersionPath('https://provider.test/api')).toBe(false)
    expect(hasApiVersionPath('https://provider.test/v1/models')).toBe(false)
    expect(hasApiVersionPath('not a url')).toBe(false)
  })

  it('appends /v1 only when the base is unversioned', () => {
    expect(ensureOpenAiV1Base('https://provider.test')).toBe('https://provider.test/v1')
    expect(ensureOpenAiV1Base('https://provider.test/')).toBe('https://provider.test/v1')
    expect(ensureOpenAiV1Base('https://provider.test/v1')).toBe('https://provider.test/v1')
    expect(ensureOpenAiV1Base('https://provider.test/v2')).toBe('https://provider.test/v2')
    expect(ensureOpenAiV1Base('https://provider.test/v1beta/')).toBe('https://provider.test/v1beta')
  })

  it('compares bases by their canonical form', () => {
    expect(sameApiBaseUrl('https://provider.test/', 'https://provider.test')).toBe(true)
    expect(sameApiBaseUrl('https://provider.test/v1', 'https://provider.test/v2')).toBe(false)
    expect(sameApiBaseUrl('', 'https://provider.test')).toBe(false)
    expect(sameApiBaseUrl('not a url', 'https://provider.test')).toBe(false)
  })
})
