import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle, Puzzle } from 'lucide-react'
import type { PluginRecord } from '../../../shared/plugins'
import { PluginFrame } from './PluginFrame'

interface PluginPanelHostProps {
  plugin: PluginRecord
  theme: 'light' | 'dark'
}

/**
 * 插件面板宿主：把插件 panel 入口加载进沙箱 iframe（唯一源、无同源权限），
 * 通过 postMessage 与受控 IPC 中转面板请求。
 */
export function PluginPanelHost({ plugin, theme }: PluginPanelHostProps): JSX.Element {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(plugin.error ?? null)
  const [reloadRevision, setReloadRevision] = useState(0)

  useEffect(() => {
    setReady(false)
    setError(plugin.error ?? null)
  }, [plugin.manifest.id, plugin.error, plugin.revision])

  const reload = useCallback(() => {
    setReady(false)
    setError(null)
    setReloadRevision((current) => current + 1)
  }, [])

  return (
    <div className="plugin-panel-host" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="content-toolbar" style={{ flexShrink: 0 }}>
        <div>
          <h1><Puzzle size={16} style={{ verticalAlign: '-2px', marginRight: 6 }} />{plugin.manifest.name}</h1>
          <span className="visually-hidden">{plugin.manifest.description} · v{plugin.manifest.version} · {plugin.scope === 'project' ? '项目级' : '全局'}</span>
        </div>
        <button className="secondary-button compact" type="button" onClick={reload}>重新加载</button>
      </div>
      {error ? (
        <div className="large-empty" style={{ flex: 1 }}>
          <AlertTriangle size={26} />
          <h3>插件无法加载</h3>
          <p>{error}</p>
        </div>
      ) : (
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {!ready ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <LoaderCircle className="spin" size={22} />
            </div>
          ) : null}
          <PluginFrame
            key={`${plugin.revision ?? 0}:${reloadRevision}`}
            plugin={plugin}
            entry={plugin.manifest.panel?.entry ?? ''}
            theme={theme}
            surface="panel"
            className="plugin-panel-frame"
            onReady={() => setReady(true)}
            onError={setError}
          />
        </div>
      )}
    </div>
  )
}
