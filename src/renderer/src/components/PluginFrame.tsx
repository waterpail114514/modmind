import { useEffect, useMemo, useRef } from 'react'
import { isPluginPanelMessage, type PluginLogSource, type PluginRecord } from '../../../shared/plugins'

interface PluginFrameProps {
  plugin: PluginRecord
  entry: string
  theme: 'light' | 'dark'
  surface: 'panel' | 'overlay'
  className?: string
  onReady?: () => void
  onError?: (message: string) => void
}

/** Shared sandbox and host bridge for normal panels and persistent overlays. */
export function PluginFrame({ plugin, entry, theme, surface, className, onReady, onError }: PluginFrameProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const source = useMemo(
    () => `modmind-plugin://${plugin.manifest.id}/${entry}?revision=${plugin.revision ?? 0}`,
    [entry, plugin.manifest.id, plugin.revision]
  )

  useEffect(() => {
    const respond = (value: unknown): void => iframeRef.current?.contentWindow?.postMessage(value, '*')
    const listener = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow || !isPluginPanelMessage(event.data)) return
      const data = event.data

      if (data.type === 'ready') {
        onReady?.()
        void window.modmind.plugins.getProjectInfo(plugin.manifest.id).then((project) => {
          respond({ type: 'hostInfo', hostInfo: { pluginId: plugin.manifest.id, panelVersion: 1, theme, surface, project } })
        }).catch(() => {
          respond({ type: 'hostInfo', hostInfo: { pluginId: plugin.manifest.id, panelVersion: 1, theme, surface, project: null } })
        })
        return
      }

      if (data.type === 'log') {
        void window.modmind.plugins.recordLog(plugin.manifest.id, surface as PluginLogSource, data.level, data.message).catch(() => undefined)
        return
      }

      const complete = (requestId: string, operation: Promise<unknown>): void => {
        void operation.then((result) => respond({ type: 'result', requestId, ok: true, result })).catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          respond({ type: 'result', requestId, ok: false, error: message })
        })
      }

      switch (data.type) {
        case 'context':
          complete(data.requestId, window.modmind.plugins.handleContextOp(plugin.manifest.id, data.op, data.args ?? {}))
          break
        case 'invokeTool':
          complete(data.requestId, window.modmind.plugins.invokeTool(plugin.manifest.id, data.toolName, data.input))
          break
        case 'getProjectInfo':
          complete(data.requestId, window.modmind.plugins.getProjectInfo(plugin.manifest.id))
          break
        case 'netFetch':
          complete(data.requestId, window.modmind.plugins.handleContextOp(plugin.manifest.id, 'netFetch', { url: data.url, init: data.init ?? {} }))
          break
        case 'copyToClipboard':
          complete(data.requestId, window.modmind.plugins.copyToClipboard(plugin.manifest.id, data.text))
          break
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [onError, onReady, plugin.manifest.id, surface, theme])

  return (
    <iframe
      ref={iframeRef}
      src={source}
      title={`${plugin.manifest.name} ${surface === 'overlay' ? '悬浮界面' : '面板'}`}
      sandbox="allow-scripts allow-downloads"
      className={className}
      onError={() => onError?.('插件界面加载失败')}
    />
  )
}
