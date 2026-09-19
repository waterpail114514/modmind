/** Shared native scrollbar chrome. Browser scrolling, keyboard access, selection,
 * virtualization and drag behavior remain native; only the paint is replaced. */
export const scrollbarMetrics = { size: 10, inset: 3, hoverInset: 2, endGap: 12, minimumThumb: 28, idle: .28, hover: .52, active: .72 } as const

export function scrollbarStyles(color = 'var(--theme-subtle)', scope = 'body'): string {
  const target = `:is(html, ${scope}, ${scope} *)`
  const { size, inset, hoverInset, endGap, minimumThumb, idle, hover, active } = scrollbarMetrics
  return `
${target} { --scrollbar-start: ${endGap}px; scrollbar-width: auto !important; scrollbar-color: auto !important; }
${target}::-webkit-scrollbar { width: ${size}px !important; height: ${size}px !important; background: transparent !important; }
${target}::-webkit-scrollbar-track, ${target}::-webkit-scrollbar-track-piece, ${target}::-webkit-scrollbar-corner { background: transparent !important; border: 0 !important; box-shadow: none !important; }
${target}::-webkit-scrollbar-track:vertical { margin-top: var(--scrollbar-start) !important; margin-bottom: ${endGap}px !important; }
${target}::-webkit-scrollbar-track:horizontal { margin-left: ${endGap}px !important; margin-right: ${endGap}px !important; }
${target}::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
${target}::-webkit-scrollbar-thumb {
  min-height: ${minimumThumb}px !important; min-width: ${minimumThumb}px !important;
  border: ${inset}px solid transparent !important; border-radius: ${size}px !important;
  background: color-mix(in srgb, ${color} ${idle * 100}%, transparent) !important;
  background-clip: padding-box !important; box-shadow: none !important;
}
${target}::-webkit-scrollbar-thumb:hover { border-width: ${hoverInset}px !important; background-color: color-mix(in srgb, ${color} ${hover * 100}%, transparent) !important; }
${target}::-webkit-scrollbar-thumb:active { background-color: color-mix(in srgb, ${color} ${active * 100}%, transparent) !important; }
@media (pointer: coarse) {
  ${target}::-webkit-scrollbar { width: 14px !important; height: 14px !important; }
}
@media (forced-colors: active) {
  ${target}::-webkit-scrollbar-thumb { background: CanvasText !important; background-clip: padding-box !important; }
}
`
}

export function scrollbarColors(palette: { subtle: string }): { idle: string; hover: string; active: string } {
  const alpha = (opacity: number): string => palette.subtle + Math.round(opacity * 255).toString(16).padStart(2, '0')
  return { idle: alpha(scrollbarMetrics.idle), hover: alpha(scrollbarMetrics.hover), active: alpha(scrollbarMetrics.active) }
}
