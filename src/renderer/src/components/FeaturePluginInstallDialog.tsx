import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { PackagePlus, ShieldCheck, X } from 'lucide-react'
import type { FeaturePluginInstallPreview } from '../../../shared/featurePlugins'
import './plugin-install-dialog.css'
import './feature-plugin-settings.css'

export default function FeaturePluginInstallDialog({ preview, onResolve }: { preview: FeaturePluginInstallPreview; onResolve: (accepted: boolean) => void }): React.JSX.Element {
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
    <header className="plugin-install-header"><h2 id={`${id}-title`}>安装应用功能插件</h2><button className="icon-button" aria-label="取消安装并关闭" title="关闭" onClick={() => onResolve(false)}><X size={18} /></button></header>
    <div className="plugin-install-body">
      <div className="plugin-install-identity"><span className="plugin-install-symbol"><PackagePlus size={24} /></span><div><div className="plugin-install-name"><h3>{preview.name}</h3><span>{preview.version}</span></div><p className="plugin-install-description">{preview.fileName}</p></div></div>
      <div className="feature-install-trust" id={`${id}-trust`}><ShieldCheck size={18} /><p>此插件可访问本机文件、网络和应用数据。请仅安装你信任来源的插件。</p></div>
    </div>
    <footer className="plugin-install-footer"><button ref={cancel} className="secondary-button" onClick={() => onResolve(false)}>取消</button><button className="primary-button" onClick={() => onResolve(true)}>信任并安装</button></footer>
  </dialog>, document.body)
}
