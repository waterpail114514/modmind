import { describe, expect, it } from 'vitest'
import { blockbenchThemeColors, getThemePalette, miniPaintThemeColors, normalizeBackground, normalizeCustomThemeColors, normalizeThemePreset, themeCssVariables, themePresets } from './appTheme'

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}
function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
describe('application palettes', () => {
  it('normalizes local media references and bounds background settings', () => {
    expect(normalizeBackground({ media: { file: '../../secret.png', name: 'invalid' }, opacity: Infinity, blur: -5 }).media).toBeNull()
    const background = normalizeBackground({ media: { file: '12345678-1234-1234-1234-123456789012.mp4', name: 'demo.mp4', kind: 'image' }, opacity: 2, blur: 99 })
    expect(background.media?.kind).toBe('video')
    expect(background.opacity).toBe(1)
    expect(background.blur).toBe(24)
    expect(normalizeCustomThemeColors({ light: { canvas: 'red', accent: 'url(foo)' } })).toEqual({})
  })
  it('derives readable custom palettes and synchronizes every adapter', () => {
    for (const canvas of ['#ffffff', '#000000', '#ff00ff', '#808080', '#00ffff']) for (const accent of ['#ffff00', '#000000', '#ffffff', '#008080']) {
      const custom = { light: { canvas, accent } }
      const p = getThemePalette('modmind', 'light', custom)
      expect(p.canvas).toBe(canvas)
      expect(p.action).toBe(accent)
      for (const text of [p.text, p.muted, p.accent]) for (const bg of [p.canvas, p.surface, p.raised]) expect(contrast(text, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.onAction, p.action)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.onAction, p.dangerAction)).toBeGreaterThanOrEqual(4.5)
      expect(blockbenchThemeColors('modmind', 'light', custom).back).toBe(canvas)
      expect(miniPaintThemeColors('modmind', 'light', custom)['--background']).toBe(canvas)
      expect(themeCssVariables('modmind', 'light', custom)['--theme-canvas']).toBe(canvas)
    }
  })
  it('normalizes old or invalid saved choices', () => {
    expect(normalizeThemePreset(undefined)).toBe('neutral')
    expect(normalizeThemePreset('not-a-theme')).toBe('neutral')
    expect(normalizeThemePreset('sage')).toBe('sage')
  })
  for (const preset of themePresets) for (const mode of ['light', 'dark'] as const) {
    it(`${preset.id}/${mode} keeps text readable and adapters synchronized`, () => {
      const p = getThemePalette(preset.id, mode)
      for (const text of [p.text, p.muted, p.accent]) for (const background of [p.canvas, p.surface, p.raised]) expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.onAction, p.action)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.onAction, p.dangerAction)).toBeGreaterThanOrEqual(4.5)
      const css = themeCssVariables(preset.id, mode)
      expect(css['--theme-canvas']).toBe(p.canvas)
      expect(blockbenchThemeColors(preset.id, mode).back).toBe(p.canvas)
      expect(miniPaintThemeColors(preset.id, mode)['--background']).toBe(p.canvas)
    })
  }
})
