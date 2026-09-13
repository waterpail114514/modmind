import { useEffect, useState } from 'react'
import { GripHorizontal, PanelTopOpen, Pin, PinOff, X } from 'lucide-react'
import type { PluginOverlayWindowState, PluginRecord } from '../../../shared/plugins'
import { PluginFrame } from './PluginFrame'

function requestedPluginId(): string {
  const value = new URLSearchParams(window.location.search).get('pluginOverlay') ?? ''
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value) ? value : ''
}

export function ExternalPluginOverlayRoot(): JSX.Element {
  const pluginId = requestedPluginId()
  const [plugin, setPlugin] = useState<PluginRecord | null>(null)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const theme: 'light' | 'dark' = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

  useEffect(() => {
    const select = (plugins: PluginRecord[]): void => {
      const next = plugins.find((candidate) => candidate.manifest.id === pluginId && candidate.enabled && !candidate.error && candidate.manifest.overlay) ?? null
      setPlugin(next)
      if (!next) void window.modmind.app.close()
    }
    void window.modmind.plugins.list().then((snapshot) => select(snapshot.plugins)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    const unsubscribePlugins = window.modmind.plugins.onChanged((snapshot) => select(snapshot.plugins))
    void window.modmind.plugins.getOverlayWindows().then((states) => setAlwaysOnTop(states.find((state) => state.pluginId === pluginId)?.alwaysOnTop ?? false)).catch(() => undefined)
    const unsubscribeWindows = window.modmind.plugins.onOverlayWindowsChanged((states: PluginOverlayWindowState[]) => {
      setAlwaysOnTop(states.find((state) => state.pluginId === pluginId)?.alwaysOnTop ?? false)
    })
    return () => { unsubscribePlugins(); unsubscribeWindows() }
  }, [pluginId])

  if (!plugin) return <div className="external-plugin-overlay-loading">{error ?? '正在载入悬浮插件'}</div>

  return (
    <main className={`external-plugin-overlay ${plugin.manifest.overlay?.mode === 'pet' ? 'pet' : ''}`}>
      <header className="external-plugin-overlay-toolbar">
        <GripHorizontal size={14} />
        <span>{plugin.manifest.name}</span>
        <button type="button" title="收回 ModMind" aria-label="收回 ModMind" onClick={() => void window.modmind.plugins.closeOverlayWindow(pluginId)}><PanelTopOpen size={13} /></button>
        <button
          type="button"
          title={alwaysOnTop ? '取消置顶' : '置顶'}
          aria-label={alwaysOnTop ? '取消置顶' : '置顶'}
          onClick={() => void window.modmind.plugins.setOverlayAlwaysOnTop(pluginId, !alwaysOnTop).then((state) => setAlwaysOnTop(state.alwaysOnTop))}
        >
          {alwaysOnTop ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button type="button" title="关闭" aria-label="关闭" onClick={() => void window.modmind.plugins.setOverlayVisible(pluginId, false)}><X size={14} /></button>
      </header>
      <PluginFrame
        plugin={plugin}
        entry={plugin.manifest.overlay?.entry ?? ''}
        theme={theme}
        surface="overlay"
        className="plugin-overlay-frame"
        onError={setError}
      />
      {error ? <div className="external-plugin-overlay-error">{error}</div> : null}
    </main>
  )
}
