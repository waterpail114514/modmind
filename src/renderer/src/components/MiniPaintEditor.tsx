import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Save } from 'lucide-react'
import type { ImageAsset } from '../../../shared/imageStudio'

const CHANNEL = 'modmind-minipaint'

interface MiniPaintEditorProps {
  asset: ImageAsset | null
  darkMode: boolean
  onError: (message: string) => void
  onSave?: (dataUrl: string) => Promise<void>
}

type PendingOpen = { requestId: string; assetId: string }

export default function MiniPaintEditor({ asset, darkMode, onError, onSave }: MiniPaintEditorProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const loadedAssetId = useRef('')
  const pendingOpen = useRef<PendingOpen | null>(null)
  const [ready, setReady] = useState(false)
  const [assetReady, setAssetReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const exportRequest = useRef('')
  const source = useMemo(() => new URL('minipaint/index.html?lang=zh', window.location.href).toString(), [])

  const post = (value: Record<string, unknown>): void => iframeRef.current?.contentWindow?.postMessage({ channel: CHANNEL, ...value }, '*')

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow || !event.data || event.data.channel !== CHANNEL) return
      if (event.data.type === 'ready') { setReady(true); return }
      const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
      if (event.data.type === 'exportResult' && requestId === exportRequest.current && typeof event.data.dataUrl === 'string') {
        exportRequest.current = ''
        void onSave?.(event.data.dataUrl).catch(error => onError(error instanceof Error ? error.message : String(error))).finally(() => setSaving(false))
        return
      }
      const currentOpen = pendingOpen.current
      if (event.data.type === 'openResult' && currentOpen && currentOpen.requestId === requestId) {
        loadedAssetId.current = currentOpen.assetId
        pendingOpen.current = null
        setAssetReady(true)
        return
      }
      if (event.data.type === 'error') {
        const message = typeof event.data.message === 'string' ? event.data.message : 'miniPaint 操作失败'
        if (pendingOpen.current?.requestId === requestId) {
          pendingOpen.current = null
          setAssetReady(false)
        }
        onError(message)
        if (requestId === exportRequest.current) { exportRequest.current = ''; setSaving(false) }
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [onError, onSave])

  useEffect(() => { if (ready) post({ type: 'theme', theme: darkMode ? 'dark' : 'light' }) }, [darkMode, ready])
  useEffect(() => {
    if (!ready || !asset || loadedAssetId.current === asset.id) return
    const requestId = crypto.randomUUID()
    pendingOpen.current = { requestId, assetId: asset.id }
    setAssetReady(false)
    post({ type: 'open', requestId, dataUrl: asset.dataUrl, name: `modmind-${asset.id}.png` })
  }, [asset?.id, ready])

  return <div className="minipaint-shell">{onSave ? <button className="primary-button" style={{ position: 'absolute', right: 12, top: 8, zIndex: 2 }} disabled={!assetReady || saving} onClick={() => { exportRequest.current = crypto.randomUUID(); setSaving(true); post({ type: 'export', requestId: exportRequest.current }) }}><Save size={15} />保存到资源包</button> : null}<iframe ref={iframeRef} className="minipaint-frame" src={source} title="miniPaint 图像编辑器" sandbox="allow-same-origin allow-scripts allow-downloads allow-forms" allow="clipboard-read; clipboard-write" />{!ready || !assetReady ? <div className="minipaint-loading"><LoaderCircle className="spin" size={22} /><span>{ready ? '正在打开图片' : '正在载入 miniPaint'}</span></div> : null}</div>
}
