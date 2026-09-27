import { useEffect, useState } from 'react'
import { emptySidebarLayout, migrateSidebarLayout, parseSidebarLayout, type SidebarLayout } from './sidebarLayout'

function readLayout(key: string, legacyKey: string): { layout: SidebarLayout; error: string } {
  try {
    const saved = localStorage.getItem(key)
    return { layout: saved === null
      ? migrateSidebarLayout(JSON.parse(localStorage.getItem(legacyKey) ?? '{}'), JSON.parse(localStorage.getItem(`${legacyKey}:groups`) ?? '[]'))
      : parseSidebarLayout(JSON.parse(saved)), error: '' }
  } catch { return { layout: emptySidebarLayout(), error: '侧边栏布局无法读取，暂时显示默认布局。可重试读取或恢复默认。' } }
}

export function useSidebarLayout(key: string, legacyKey: string) {
  const [state, setState] = useState(() => ({ key, ...readLayout(key, legacyKey), history: [] as SidebarLayout[] }))
  const [pending, setPending] = useState<{ key: string; layout: SidebarLayout; undo: boolean } | null>(null)
  if (state.key !== key) {
    setState({ key, ...readLayout(key, legacyKey), history: [] })
    setPending(null)
  }
  const reload = (): void => { setState({ key, ...readLayout(key, legacyKey), history: [] }); setPending(null) }
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === key || event.key === null) reload() }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, legacyKey])
  const save = (layout: SidebarLayout, undo = false): boolean => {
    if (state.key !== key) return false
    try {
      localStorage.setItem(key, JSON.stringify(layout))
      setState(current => ({ key, layout, error: '', history: undo ? current.history.slice(0, -1) : [...current.history.slice(-19), current.layout] }))
      setPending(null)
      return true
    } catch {
      setState(current => ({ ...current, error: '侧边栏未保存，当前布局未更改。请重试。' }))
      setPending({ key, layout, undo })
      return false
    }
  }
  return {
    layout: state.layout, error: state.error, save,
    canUndo: state.history.length > 0,
    undo: () => { const previous = state.history.at(-1); if (previous) save(previous, true) },
    retry: () => { if (pending?.key === key) save(pending.layout, pending.undo); else reload() }
  }
}
