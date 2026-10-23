import { describe, expect, it } from 'vitest'
import { parseShaderOptions } from './shaderOptionParser'

const source = `#ifndef SETTINGS_GUARD
#define SETTINGS_GUARD
#define TAA
// #define BLOOM
#define EXPOSURE 1.00 // [0.50 1.00 1.50]
const int shadowMapResolution = 3072; // [1024 3072 4096]
const float shadowDistance = 112.0; // [48.0 112.0 224.0]
const bool shadowHardwareFiltering = true;
const float privateConstant = 1.0; // [1.0 2.0]
#define UNUSED_INTERNAL
/*
#define FAKE 1 // [1 2]
*/
#ifdef TAA
#endif
#ifdef BLOOM
#endif
#endif`
const parse = (config = '', sources = [{ path: 'shaders/lib/settings.glsl', content: source }]) => parseShaderOptions(sources, config,
  'option.shadowDistance=阴影距离\nscreen.LIGHT=光照\n', ['shaders/composite', 'shaders/world-1/composite'])

describe('source shader options and Iris profiles', () => {
  it('excludes guards, unused macros and block comments; retains supported const options and source locations', () => {
    const result = parse('sliders=EXPOSURE shadowDistance\nscreen=[LIGHT]\nscreen.LIGHT=shadowDistance shadowMapResolution TAA *')
    expect(result.options.map(option => option.name)).toEqual(['TAA', 'BLOOM', 'EXPOSURE', 'shadowMapResolution', 'shadowDistance', 'shadowHardwareFiltering'])
    expect(result.options.find(option => option.name === 'BLOOM')).toMatchObject({ value: 'false', declaration: 'toggle' })
    expect(result.options.find(option => option.name === 'shadowDistance')).toMatchObject({ title: '阴影距离', slider: true, declaration: 'const', files: [{ line: 7 }] })
    expect(result.optionGroups).toEqual([{ name: 'screen.LIGHT', title: '光照', options: ['shadowDistance', 'shadowMapResolution', 'TAA', 'BLOOM', 'EXPOSURE', 'shadowHardwareFiltering'] }])
  })
  it('expands actual Iris inheritance, booleans, equals/colon values, continuations and dimension program disables', () => {
    const result = parse('profile.BASE=TAA !BLOOM EXPOSURE:1.00\nprofile.QUALITY=profile.BASE BLOOM \\\n  EXPOSURE=1.50 shadowMapResolution=4096 shadowDistance=224.0 !program.world-1/composite\nprogram.world-1/composite.enabled=BLOOM')
    expect(result.profiles.QUALITY).toEqual({ TAA: 'true', BLOOM: 'true', EXPOSURE: '1.50', shadowMapResolution: '4096', shadowDistance: '224.0' })
    expect(result.profilePrograms.QUALITY).toEqual({ 'world-1/composite': false })
    expect(result.programConditions['world-1/composite']).toBe('BLOOM')
    expect(result.profileIssues).toEqual({})
  })
  it('keeps invalid profiles unavailable instead of applying partial settings', () => {
    const result = parse('profile.A=profile.B\nprofile.B=profile.A\nprofile.MISSING=profile.NO\nprofile.BAD=EXPOSURE=9\nprofile.UNKNOWN=UNKNOWN\nprofile.PROGRAM=!program.no_such\nprofile.DUP=TAA\nprofile.DUP=!TAA\nprofile.OK=EXPOSURE=1.50')
    expect(Object.keys(result.profiles)).toEqual(['OK'])
    for (const name of ['A', 'B', 'MISSING', 'BAD', 'UNKNOWN', 'PROGRAM', 'DUP']) expect(result.profileIssues[name]?.length).toBeGreaterThan(0)
  })
  it('rejects ambiguous duplicate declarations and preserves unambiguous repeated occurrences', () => {
    const result = parse('profile.BAD=EXPOSURE=1.50', [{ path: 'shaders/a.glsl', content: source }, { path: 'shaders/b.glsl', content: '#define EXPOSURE 0.50 // [0.50 1.00 1.50]\n#define TAA\n#ifdef TAA\n#endif' }])
    expect(result.options.some(option => option.name === 'EXPOSURE')).toBe(false)
    expect(result.options.find(option => option.name === 'TAA')?.files).toHaveLength(2)
    expect(result.optionIssues[0].message).toContain('重复声明')
    expect(result.profileIssues.BAD[0]).toContain('无效')
  })
  it('bounds menu and profile recursion and reports conditional configuration separately', () => {
    const result = parse('#if BLOOM\nscreen=[LOOP]\nscreen.LOOP=[LOOP]\n#endif')
    expect(result.configurationConditional).toBe(true)
    expect(result.optionIssues.some(issue => issue.message.includes('菜单循环'))).toBe(true)
    expect(result.optionIssues.some(issue => issue.message.includes('条件分支'))).toBe(true)
    expect(result.optionGroups[0].options).toHaveLength(6)
  })
})
