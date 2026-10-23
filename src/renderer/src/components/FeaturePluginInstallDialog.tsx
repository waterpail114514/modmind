import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PackagePlus, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { FeaturePluginInstallPreview } from '../../../shared/featurePlugins'
import './plugin-install-dialog.css'
import './feature-plugin-settings.css'

export function FeaturePluginInstallGate({ tutorialActive = false }: { tutorialActive?: boolean } = {}): React.JSX.Element | null {
  const [request, setRequest] = useState<{ requestId: string; preview: FeaturePluginInstallPreview } | null>(null)
  const pending = useRef<string | null>(null)
  useEffect(() => {
    const unsubscribe = window.modmind.featurePlugins.onInstallPreview((requestId, preview) => {
      if (pending.current) window.modmind.featurePlugins.confirmInstall(pending.current, false)
      pending.current = requestId; setRequest({ requestId, preview })
    })
    return () => { unsubscribe(); if (pending.current) window.modmind.featurePlugins.confirmInstall(pending.current, false) }
  }, [])
  return request ? <FeaturePluginInstallDialog tutorialActive={tutorialActive} preview={request.preview} onResolve={accepted => {
    window.modmind.featurePlugins.confirmInstall(request.requestId, accepted)
    pending.current = null; setRequest(null)
  }} /> : null
}

export default function FeaturePluginInstallDialog({ preview, onResolve, tutorialActive = false }: { preview: FeaturePluginInstallPreview; onResolve: (accepted: boolean) => void; tutorialActive?: boolean }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal(); cancel.current?.focus({ preventScroll: true })
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={dialog} className="plugin-install-dialog feature-install-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-trust`} onCancel={event => { event.preventDefault(); onResolve(false) }}>
    <header className="plugin-install-header"><h2 id={`${id}-title`}>{preview.fileName.endsWith('.mmstudio') ? '安装工作台' : '安装应用功能插件'}</h2><button className="icon-button" aria-label="取消安装并关闭" title="关闭" onClick={() => onResolve(false)}><X size={18} /></button></header>
    <div className="plugin-install-body">
      {tutorialActive && <p className="onboarding-install-note"><Sparkles size={16} />确认来源后，点击发光的「信任并安装」继续。取消后可以重新尝试。</p>}
      <div className="plugin-install-identity"><span className="plugin-install-symbol"><PackagePlus size={24} /></span><div><div className="plugin-install-name"><h3>{preview.name}</h3><span>{preview.version}</span></div><p className="plugin-install-description">{preview.fileName}</p></div></div>
      <div className="feature-install-trust" id={`${id}-trust`}><ShieldCheck size={18} /><p>此插件可访问本机文件、网络和应用数据。请仅安装你信任来源的插件。</p></div>
    </div>
    <footer className="plugin-install-footer"><button ref={cancel} className="secondary-button" onClick={() => onResolve(false)}>取消</button><button className={`primary-button${tutorialActive ? ' onboarding-install-action' : ''}`} onClick={() => onResolve(true)}>信任并安装</button></footer>
  </dialog>, document.body)
}
