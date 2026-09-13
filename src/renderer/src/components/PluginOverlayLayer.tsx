import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, GripHorizontal, X } from 'lucide-react'
import type { PluginOverlayWindowState, PluginRecord, PluginSnapshot } from '../../../shared/plugins'
import { PluginFrame } from './PluginFrame'

interface PluginOverlayLayerProps {
  snapshot: PluginSnapshot
  theme: 'light' | 'dark'
}

interface Position {
  x: number
  y: number
}

function boundsFor(plugin: PluginRecord): { width: number; height: number } {
  const overlay = plugin.manifest.overlay
  return {
    width: overlay?.width ?? (overlay?.mode === 'pet' ? 220 : 360),
    height: overlay?.height ?? (overlay?.mode === 'pet' ? 280 : 300)
  }
}

function initialPosition(plugin: PluginRecord): Position {
  const { width, height } = boundsFor(plugin)
  try {
    const stored = JSON.parse(localStorage.getItem(`modmind-plugin-overlay:${plugin.manifest.id}`) ?? 'null') as Partial<Position> | null
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) return { x: Number(stored.x), y: Number(stored.y) }
  } catch {
    // Use the default bottom-right position.
  }
  return { x: Math.max(12, window.innerWidth - width - 24), y: Math.max(48, window.innerHeight - height - 24) }
}

function InAppPluginOverlay({ plugin, theme, order }: { plugin: PluginRecord; theme: 'light' | 'dark'; order: number }): JSX.Element {
  const dimensions = boundsFor(plugin)
  const [position, setPosition] = useState<Position>(() => initialPosition(plugin))
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)

  const clamp = (candidate: Position): Position => ({
    x: Math.min(Math.max(0, candidate.x), Math.max(0, window.innerWidth - dimensions.width)),
    y: Math.min(Math.max(32, candidate.y), Math.max(32, window.innerHeight - dimensions.height))
  })

  useEffect(() => {
    const resize = (): void => setPosition((current) => {
      const next = {
        x: Math.min(Math.max(0, current.x), Math.max(0, window.innerWidth - dimensions.width)),
        y: Math.min(Math.max(32, current.y), Math.max(32, window.innerHeight - dimensions.height))
      }
      return next.x === current.x && next.y === current.y ? current : next
    })
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [dimensions.height, dimensions.width])

  const persist = (next: Position): void => {
    try { localStorage.setItem(`modmind-plugin-overlay:${plugin.manifest.id}`, JSON.stringify(next)) } catch { /* storage can be unavailable */ }
  }

  return (
    <section
      className={`plugin-overlay-surface ${plugin.manifest.overlay?.mode === 'pet' ? 'pet' : ''}`}
      style={{ left: position.x, top: position.y, width: dimensions.width, height: dimensions.height, zIndex: 80 + order }}
      aria-label={`${plugin.manifest.name} 悬浮界面`}
    >
      <header
        className="plugin-overlay-toolbar"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          drag.current = { pointerId: event.pointerId, offsetX: event.clientX - position.x, offsetY: event.clientY - position.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return
          setPosition(clamp({ x: event.clientX - drag.current.offsetX, y: event.clientY - drag.current.offsetY }))
        }}
        onPointerUp={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          setPosition((current) => { persist(current); return current })
        }}
        onPointerCancel={() => { drag.current = null }}
      >
        <GripHorizontal size={14} aria-hidden="true" />
        <span>{plugin.manifest.name}</span>
        <button type="button" title="弹出到桌面" aria-label="弹出到桌面" onClick={() => void window.modmind.plugins.openOverlayWindow(plugin.manifest.id)}>
          <ExternalLink size={13} />
        </button>
        <button type="button" title="关闭悬浮界面" aria-label="关闭悬浮界面" onClick={() => void window.modmind.plugins.setOverlayVisible(plugin.manifest.id, false)}>
          <X size={13} />
        </button>
      </header>
      <PluginFrame
        plugin={plugin}
        entry={plugin.manifest.overlay?.entry ?? ''}
        theme={theme}
        surface="overlay"
        className="plugin-overlay-frame"
      />
    </section>
  )
}

export function PluginOverlayLayer({ snapshot, theme }: PluginOverlayLayerProps): JSX.Element | null {
  const [externalWindows, setExternalWindows] = useState<PluginOverlayWindowState[]>([])
  useEffect(() => {
    let disposed = false
    void window.modmind.plugins.getOverlayWindows().then((states) => { if (!disposed) setExternalWindows(states) }).catch(() => undefined)
    const unsubscribe = window.modmind.plugins.onOverlayWindowsChanged(setExternalWindows)
    return () => { disposed = true; unsubscribe() }
  }, [])

  const externalIds = useMemo(() => new Set(externalWindows.filter((state) => state.open || state.hidden).map((state) => state.pluginId)), [externalWindows])
  const overlays = snapshot.plugins.filter((plugin) => plugin.enabled && !plugin.error && plugin.manifest.overlay && !externalIds.has(plugin.manifest.id))
  if (!overlays.length) return null

  return <div className="plugin-overlay-layer">{overlays.map((plugin, index) => <InAppPluginOverlay key={`${plugin.manifest.id}:${plugin.revision ?? 0}`} plugin={plugin} theme={theme} order={index} />)}</div>
}
