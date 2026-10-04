import { useEffect, useRef, useState } from 'react'
import { readSurfaceAiSelection, type SurfaceAiSelection } from '../../shared/aiSelection'

export function useSurfaceAiSelection(surface: string): [SurfaceAiSelection | undefined, (value: SurfaceAiSelection | undefined) => void] {
  const key = `modmind-ai-selection:${surface}`
  const [selection, setSelection] = useState(() => { try { return readSurfaceAiSelection(localStorage.getItem(key)) } catch { return undefined } })
  const revision = useRef(0)
  useEffect(() => {
    const reset = (): void => { revision.current++; setSelection(undefined); try { localStorage.removeItem(key) } catch { /* In-memory reset remains available. */ } }
    window.addEventListener('modmind-ai-defaults-applied', reset)
    return () => window.removeEventListener('modmind-ai-defaults-applied', reset)
  }, [key])
  useEffect(() => {
    if (surface !== 'workspace' && surface !== 'inspiration') return
    let active = true
    const requestRevision = revision.current
    const apply = (value: SurfaceAiSelection): void => { revision.current++; setSelection(value); try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Selection remains usable. */ } }
    const remove = window.modmind.device.onAiSelection?.(value => {
      if (value.surface !== surface) return
      if (value.selection) apply({ ...value.selection, backend: 'quota' })
      else { revision.current++; setSelection(undefined); try { localStorage.removeItem(key) } catch { /* In-memory reset remains available. */ } }
    })
    void window.modmind.device.getModelCatalog().then(catalog => {
      if (!active || revision.current !== requestRevision || catalog.protocolVersion !== 2) return
      const value = catalog.bindings?.[surface]
      const local = readSurfaceAiSelection(localStorage.getItem(key))
      if (value) apply({ ...value, ...(local?.backend === 'quota' && local.model === value.model && local.account === value.account ? { reasoningLevel: local.reasoningLevel } : {}), backend: 'quota' })
      else if (local?.backend === 'quota') { setSelection(undefined); localStorage.removeItem(key) }
    }).catch(() => undefined)
    return () => { active = false; remove?.() }
  }, [surface, key])
  return [selection, value => {
    revision.current++
    setSelection(value)
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key) } catch { /* The selection still works for this window. */ }
  }]
}

export function resetSurfaceAiSelections(): void {
  try { Object.keys(localStorage).filter(key => key.startsWith('modmind-ai-selection:')).forEach(key => localStorage.removeItem(key)) } catch { /* Notify mounted surfaces as well. */ }
  window.dispatchEvent(new Event('modmind-ai-defaults-applied'))
}
