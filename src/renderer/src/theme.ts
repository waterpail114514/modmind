import { useSyncExternalStore } from 'react'
import { normalizeAppearance, themeCssVariables, type AppAppearance } from '../../shared/appTheme'

const key = 'modmind-appearance:v1'
let current: AppAppearance = { darkMode: false, themePreset: 'neutral' }
try { current = normalizeAppearance(JSON.parse(localStorage.getItem(key) ?? '{}')) } catch { /* Default theme for unavailable storage. */ }
const listeners = new Set<() => void>()
let backgroundReady = false
function renderPalette(value: AppAppearance): void {
  const variables = themeCssVariables(value.themePreset, value.darkMode ? 'dark' : 'light', value.customThemeColors)
  document.documentElement.dataset.backgroundActive = String(backgroundReady && Boolean(value.background?.media))
  document.documentElement.style.setProperty('--appearance-base', variables['--theme-canvas'])
  if (backgroundReady && value.background?.media) {
    variables['--theme-canvas'] = 'transparent'
    for (const role of ['panel', 'surface']) variables[`--theme-${role}`] = `color-mix(in srgb, ${variables[`--theme-${role}`]} 82%, transparent)`
  }
  for (const [key, color] of Object.entries(variables)) document.documentElement.style.setProperty(key, color)
}
export function setBackgroundReady(ready: boolean): void { backgroundReady = ready; renderPalette(current) }
export function applyAppearance(value: AppAppearance): void {
  const next = normalizeAppearance(value)
  document.documentElement.dataset.themePreset = next.themePreset
  document.documentElement.dataset.themeMode = next.darkMode ? 'dark' : 'light'
  if (next.background?.media?.file !== current.background?.media?.file) backgroundReady = false
  renderPalette(next)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  try { localStorage.setItem(key, JSON.stringify(current)) } catch { /* Theme remains active in memory. */ }
  listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useAppAppearance(): AppAppearance { return useSyncExternalStore(subscribe, () => current) }
applyAppearance(current)
window.addEventListener('storage', event => {
  if (event.key !== key || !event.newValue) return
  try { applyAppearance(normalizeAppearance(JSON.parse(event.newValue))) } catch { /* Ignore incomplete browser storage. */ }
})
