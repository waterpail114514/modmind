/** The only source of application UI colors. Content colors (textures, syntax,
 * Minecraft formatting) are deliberately outside the application palette. */
export const themePresets = [
  { id: 'modmind', label: 'ModMind', description: '灰色基底，Logo 青绿与金色点缀' },
  { id: 'neutral', label: '默认', description: '中性灰与沉稳蓝' },
  { id: 'sand', label: '暖砂', description: '暖灰与陶土色' },
  { id: 'sage', label: '青绿', description: '柔和灰绿' },
  { id: 'graphite', label: '石墨', description: '克制的灰阶' }
] as const
export type ThemePreset = typeof themePresets[number]['id']
export type ThemeMode = 'light' | 'dark'
export type CustomThemeColors = Partial<Record<ThemeMode, { canvas: string; accent: string }>>
export type BackgroundMedia = { file: string; name: string; kind: 'image' | 'video' }
export type AppBackground = { media: BackgroundMedia | null; opacity: number; blur: number; fit: 'cover' | 'contain'; paused: boolean }
export type AppAppearance = { darkMode: boolean; themePreset: ThemePreset; customThemeColors?: CustomThemeColors; background?: AppBackground }
export const defaultBackground: AppBackground = { media: null, opacity: 0.3, blur: 0, fit: 'cover', paused: false }
export function normalizeCustomThemeColors(value: unknown): CustomThemeColors {
  const result: CustomThemeColors = {}
  if (!value || typeof value !== 'object') return result
  for (const mode of ['light', 'dark'] as const) {
    const colors = (value as CustomThemeColors)[mode]
    if (colors && /^#[\da-f]{6}$/i.test(colors.canvas) && /^#[\da-f]{6}$/i.test(colors.accent)) {
      result[mode] = { canvas: colors.canvas.toLowerCase(), accent: colors.accent.toLowerCase() }
    }
  }
  return result
}
export function normalizeBackground(value: unknown): AppBackground {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<AppBackground>
  const media = v.media
  const valid = media && typeof media.name === 'string' && /^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|gif|mp4|webm)$/i.test(media.file)
  const kind = valid && /\.(mp4|webm)$/i.test(media.file) ? 'video' : 'image'
  const clamp = (n: unknown, max: number, fallback: number): number => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback
  return { media: valid ? { file: media.file, name: media.name.slice(0, 255), kind } : null,
    opacity: clamp(v.opacity, 1, defaultBackground.opacity), blur: clamp(v.blur, 24, 0), fit: v.fit === 'contain' ? 'contain' : 'cover', paused: v.paused === true }
}
export function normalizeThemePreset(value: unknown): ThemePreset {
  return themePresets.some(preset => preset.id === value) ? value as ThemePreset : 'neutral'
}
export function normalizeAppearance(value: { darkMode?: unknown; themePreset?: unknown; customThemeColors?: unknown; background?: unknown }): AppAppearance {
  return { darkMode: value.darkMode === true, themePreset: normalizeThemePreset(value.themePreset), customThemeColors: normalizeCustomThemeColors(value.customThemeColors), background: normalizeBackground(value.background) }
}

const neutral = {
  light: {
    canvas: '#f7f7f8', panel: '#f0f1f3', surface: '#fafafb', raised: '#ffffff', inset: '#e9eaed',
    text: '#242529', muted: '#626772', subtle: '#737780', line: '#dfe1e5', strongLine: '#a2a6af',
    accent: '#1769ce', action: '#1769ce', actionHover: '#1258b1', selected: '#e7eef8', selection: '#dce6f4',
    success: '#287047', successBg: '#e7f2eb', warning: '#875a17', warningBg: '#faf0d9', danger: '#b63832', dangerBg: '#fae9e7',
    focus: '#737780', scrim: '#181a20', shadow: '#000000', onAction: '#ffffff', dangerAction: '#b63832', detail: '#1769ce',
    console: '#202226', consoleText: '#e7e7eb', consoleMuted: '#a6abb5', grid: '#d5d8de'
  },
  dark: {
    canvas: '#1c1d20', panel: '#202226', surface: '#24262b', raised: '#2b2e34', inset: '#30333a',
    text: '#e7e7eb', muted: '#a6abb5', subtle: '#979da8', line: '#383c44', strongLine: '#646b76',
    accent: '#86b3f4', action: '#2369c5', actionHover: '#2b76d4', selected: '#2a3545', selection: '#354459',
    success: '#8ccda7', successBg: '#25382e', warning: '#e4bf7c', warningBg: '#3a3122', danger: '#ef958e', dangerBg: '#402a2a',
    focus: '#a6abb5', scrim: '#08090b', shadow: '#000000', onAction: '#ffffff', dangerAction: '#a93630', detail: '#86b3f4',
    console: '#181a1e', consoleText: '#e7e7eb', consoleMuted: '#a6abb5', grid: '#3a3d44'
  }
} as const
type BasePalette = { [K in keyof typeof neutral.light]: string }
const variants: Record<ThemePreset, Record<ThemeMode, Partial<BasePalette>>> = {
  modmind: {
    light: { canvas: '#f5f6f7', panel: '#eceef0', surface: '#f9fafb', raised: '#ffffff', inset: '#e3e6e9', text: '#2e3843', muted: '#626970', subtle: '#6d7780', line: '#dce0e4', strongLine: '#9fa8b0', accent: '#1e5a60', action: '#1e5a60', actionHover: '#16464b', selected: '#e1e6e8', selection: '#d4dfe0', focus: '#6d7780', warning: '#7e601a', warningBg: '#f4e8ca', grid: '#d5dade' },
    dark: { canvas: '#23272b', panel: '#282d32', surface: '#2e343a', raised: '#363d44', inset: '#3d454d', text: '#e8ecef', muted: '#aeb7bf', subtle: '#9ca7b0', line: '#404950', strongLine: '#73818d', accent: '#84c4c4', action: '#1e5a60', actionHover: '#246b71', selected: '#384249', selection: '#424f58', focus: '#aeb7bf', warning: '#c8a14a', warningBg: '#3d3525', grid: '#404950' }
  },
  neutral: { light: {}, dark: {} },
  sand: {
    light: { canvas: '#f7f4ee', panel: '#eee9e0', surface: '#faf7f1', raised: '#fffcf7', inset: '#e6dfd4', text: '#302b25', muted: '#70665b', subtle: '#7b7063', line: '#ded6ca', strongLine: '#aa9c8c', accent: '#925332', action: '#925332', actionHover: '#794328', selected: '#eee0d3', selection: '#e6d2be', focus: '#827362', grid: '#d7cfc3' },
    dark: { canvas: '#211e1b', panel: '#27231f', surface: '#2c2723', raised: '#35302a', inset: '#3b342d', text: '#eae4dc', muted: '#b7ab9c', subtle: '#a79b8d', line: '#443c34', strongLine: '#766858', accent: '#e0b18d', action: '#995e3b', actionHover: '#ad6b44', selected: '#443428', selection: '#574332', focus: '#b7ab9c', grid: '#443c34' }
  },
  sage: {
    light: { canvas: '#f2f6f3', panel: '#e7eeea', surface: '#f7faf8', raised: '#fcfefd', inset: '#dce6df', text: '#25302a', muted: '#5f7065', subtle: '#6c7b71', line: '#d5e0d8', strongLine: '#93a79a', accent: '#326d53', action: '#326d53', actionHover: '#26573f', selected: '#dcece2', selection: '#cbe1d3', focus: '#708678', grid: '#ccd9d0' },
    dark: { canvas: '#1b211e', panel: '#202823', surface: '#252e28', raised: '#2d3831', inset: '#334038', text: '#e1eae4', muted: '#a4b6aa', subtle: '#94a69a', line: '#36483b', strongLine: '#617b68', accent: '#99ceb0', action: '#356e50', actionHover: '#41855f', selected: '#2d4435', selection: '#3a5744', focus: '#a4b6aa', grid: '#36483b' }
  },
  graphite: {
    light: { canvas: '#f5f5f5', panel: '#ebebeb', surface: '#f9f9f9', raised: '#ffffff', inset: '#e2e2e2', text: '#262626', muted: '#666666', subtle: '#737373', line: '#dddddd', strongLine: '#a2a2a2', accent: '#444444', action: '#444444', actionHover: '#282828', selected: '#e1e1e1', selection: '#d4d4d4', focus: '#737373', grid: '#d2d2d2' },
    dark: { canvas: '#1e1e1e', panel: '#242424', surface: '#292929', raised: '#333333', inset: '#393939', text: '#e7e7e7', muted: '#aaaaaa', subtle: '#999999', line: '#3d3d3d', strongLine: '#6a6a6a', accent: '#c5c5c5', action: '#575757', actionHover: '#686868', selected: '#393939', selection: '#4a4a4a', focus: '#aaaaaa', grid: '#3b3b3b' }
  }
}
function mix(a: string, b: string, amount: number): string {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('')
}
function luminance(color: string): number {
  const c = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
}
function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
function readable(color: string, backgrounds: string[], ink: string): string {
  for (let step = 0; step <= 100; step++) {
    const adjusted = mix(color, ink, step / 100)
    if (backgrounds.every(bg => contrast(adjusted, bg) >= 4.5)) return adjusted
  }
  return ink
}
export function getThemePalette(preset: unknown = 'neutral', mode: ThemeMode = 'light', custom?: CustomThemeColors): BasePalette {
  const base: BasePalette = { ...neutral[mode], ...variants[normalizeThemePreset(preset)][mode] }
  const p: BasePalette = { ...base, detail: normalizeThemePreset(preset) === 'modmind' ? '#c8a14a' : base.accent }
  const c = normalizeCustomThemeColors(custom)[mode]
  if (!c) return p
  const ink = contrast('#000000', c.canvas) > contrast('#ffffff', c.canvas) ? '#000000' : '#ffffff'
  const isDark = ink === '#ffffff'
  const paper = isDark ? '#000000' : '#ffffff'
  const surface = mix(c.canvas, paper, .12), raised = mix(c.canvas, paper, .22)
  const backgrounds = [c.canvas, surface, raised]
  const action = c.accent
  const onAction = contrast('#ffffff', action) >= 4.5 ? '#ffffff' : '#000000'
  return { ...p, canvas: c.canvas, panel: mix(c.canvas, ink, .045), surface, raised, inset: mix(c.canvas, ink, .09),
    text: readable(mix(c.canvas, ink, .9), backgrounds, ink), muted: readable(mix(c.canvas, ink, .62), backgrounds, ink), subtle: readable(mix(c.canvas, ink, .56), backgrounds, ink),
    line: mix(c.canvas, ink, .16), strongLine: mix(c.canvas, ink, .4), focus: mix(c.canvas, ink, .6), grid: mix(c.canvas, ink, .16),
    accent: readable(c.accent, backgrounds, ink), action, onAction, detail: c.accent, actionHover: mix(action, onAction === '#ffffff' ? '#000000' : '#ffffff', .12),
    selected: mix(c.canvas, c.accent, .15), selection: mix(c.canvas, c.accent, .25),
    success: readable(p.success, backgrounds, ink), successBg: mix(c.canvas, p.success, .1), warning: readable(p.warning, backgrounds, ink), warningBg: mix(c.canvas, p.warning, .1),
    danger: readable(p.danger, backgrounds, ink), dangerBg: mix(c.canvas, p.danger, .1), dangerAction: onAction === '#ffffff' ? neutral.light.dangerAction : '#ef958e' }
}
export function themeCssVariables(preset: unknown, mode: ThemeMode, custom?: CustomThemeColors): Record<string, string> {
  return Object.fromEntries(Object.entries(getThemePalette(preset, mode, custom)).map(([name, value]) => [`--theme-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value]))
}
export function blockbenchThemeColors(preset: unknown, mode: ThemeMode, custom?: CustomThemeColors): Record<string, string> {
  const p = getThemePalette(preset, mode, custom)
  return { back: p.canvas, dark: p.panel, border: p.line, ui: p.surface, accent: p.action, button: p.raised,
    selected: p.selected, elevated: p.raised, frame: p.panel, text: p.text, light: p.text, accent_text: p.onAction,
    bright_ui_text: p.text, subtle_text: p.muted, bright_ui: p.inset, bright_border: p.strongLine, grid: p.grid,
    wireframe: p.accent, checkerboard: p.inset, menu_separator: p.line, guidelines: p.subtle }
}
export function miniPaintThemeColors(preset: unknown, mode: ThemeMode, custom?: CustomThemeColors): Record<string, string> {
  const p = getThemePalette(preset, mode, custom)
  const roles = {
    background: p.canvas, 'text-color': p.text, 'text-color-muted': p.muted, 'text-color-red': p.danger,
    'text-color-green': p.success, 'text-color-blue': p.accent, 'link-color': p.accent,
    'section-background-color': p.surface, 'area-background-color': p.panel, 'block-background-color': p.surface,
    'header-background-color': p.panel, 'button-background-color': p.raised, 'button-background-color-hover': p.panel,
    'button-background-color-active': p.selected, 'button-shadow-color': 'transparent', 'button-text-color-active': p.text,
    'button-toggle-background-color': p.selected, 'button-toggle-background-color-hover': p.inset,
    'input-background-color': p.surface, 'input-background-color-hover': p.panel, 'input-text-color': p.text,
    'input-border-color': p.line, 'input-border-color-active': p.focus, 'input-group-border-color': p.line,
    'menu-background-color': p.raised, 'menu-icons-filter': mode === 'dark' ? 'invert(1)' : 'none',
    'menu-icons-filter-active': mode === 'dark' ? 'invert(1)' : 'none', 'menu-text-color': p.text,
    'menu-dropdown-hover-background-color': p.selected, 'menu-dropdown-border-color': p.line,
    'background-color-active': p.selected, 'background-color-hover': p.panel, 'text-color-active': p.text,
    'border-color': p.line, 'scrollbar-track-color': p.canvas, 'scrollbar-thumb-color': p.strongLine,
    'mobile-menu-toggle-filter': mode === 'dark' ? 'invert(1)' : 'none'
  }
  return Object.fromEntries(Object.entries(roles).map(([key, value]) => [`--${key}`, value]))
}
