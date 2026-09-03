import { useEffect, useState } from 'react'

/**
 * 响应式断点唯一真相源（与 styles.css 的 `--bp-*` 令牌保持一致）。
 * 主窗口 `minWidth: 1080`，因此对主窗口只有「紧凑 / 全功能」一档真实生效。
 * 若将来放宽 minWidth，可在此追加更多档位。
 */
export const COMPACT_LAYOUT_QUERY = '(max-width: 1280px)'

/**
 * 订阅一个 CSS 媒体查询，返回其当前是否命中，并在跨越断点时自动更新。
 * 初次渲染即用 matchMedia 同步求值，避免展开→折叠的闪烁。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches)
    setMatches(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}
