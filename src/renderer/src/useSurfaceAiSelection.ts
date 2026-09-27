import { useState } from 'react'
import { readSurfaceAiSelection, type SurfaceAiSelection } from '../../shared/aiSelection'

export function useSurfaceAiSelection(surface: string): [SurfaceAiSelection | undefined, (value: SurfaceAiSelection | undefined) => void] {
  const key = `modmind-ai-selection:${surface}`
  const [selection, setSelection] = useState(() => { try { return readSurfaceAiSelection(localStorage.getItem(key)) } catch { return undefined } })
  return [selection, value => {
    setSelection(value)
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key) } catch { /* The selection still works for this window. */ }
  }]
}
