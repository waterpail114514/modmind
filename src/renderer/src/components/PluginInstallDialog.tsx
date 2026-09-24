import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Folder, Globe, Puzzle, RefreshCw, ShieldAlert, X } from 'lucide-react'
import type { PluginImportPreview, PluginPermission } from '../../../shared/plugins'
import './plugin-install-dialog.css'

const permissionLabels: Record<PluginPermission, string> = {
  'project.read': '读取项目信息',
  storage: '保存插件数据',
  'net.fetch': '访问网络',
  'clipboard.write': '写入剪贴板',
  'ui.overlay': '显示悬浮界面',
  'chat.read': '读取工作台对话',
  'chat.write': '填写对话输入框',
  'chat.context': '提供 AI 上下文'
}

export function PluginInstallDialog({ preview, onResolve }: { preview: PluginImportPreview; onResolve: (accepted: boolean) => void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const { manifest, scope, conflictsWith } = preview
  const ScopeIcon = scope === 'project' ? Folder : Globe

  useEffect(() => {
    const dialog = dialogRef.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    cancelRef.current?.focus({ preventScroll: true })
    return () => { dialog.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])

  return createPortal(<dialog ref={dialogRef} className="plugin-install-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-trust`} onCancel={event => { event.preventDefault(); onResolve(false) }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <header className="plugin-install-header">
      <div><span className="plugin-install-eyebrow">插件安装</span><h2 id={`${id}-title`}>安装前，请确认信任此插件</h2></div>
      <button className="icon-button" type="button" aria-label="取消安装并关闭" title="关闭（Esc）" onClick={() => onResolve(false)}><X size={18} /></button>
    </header>

    <div className="plugin-install-body">
      <section className="plugin-install-identity" aria-label="插件信息">
        <span className="plugin-install-symbol" aria-hidden="true"><Puzzle size={25} strokeWidth={1.6} /></span>
        <div><div className="plugin-install-name"><h3>{manifest.name}</h3><span>v{manifest.version}</span></div><p className="plugin-install-id">{manifest.id}{manifest.author ? ` · ${manifest.author}` : ''}</p>{manifest.description ? <p className="plugin-install-description">{manifest.description}</p> : null}</div>
      </section>

      <dl className="plugin-install-meta">
        <div><dt>安装范围</dt><dd><ScopeIcon size={14} aria-hidden="true" />{scope === 'project' ? '当前项目' : '全局 · 所有项目可用'}</dd></div>
        <div><dt>安装文件</dt><dd>{preview.fileName}</dd></div>
      </dl>

      <section className="plugin-install-trust" aria-labelledby={`${id}-trust-title`}>
        <ShieldAlert size={19} aria-hidden="true" />
        <div><h3 id={`${id}-trust-title`}>{manifest.backend ? '此插件可访问你的电脑' : '仅安装你信任的插件'}</h3><p id={`${id}-trust`}>{manifest.backend ? '插件后端可读写本机文件、访问网络、读取环境变量和启动进程，不受安全沙箱限制。' : '请确认插件来源可靠，并了解它声明的功能与能力。'}</p></div>
      </section>

      <section className="plugin-install-permissions" aria-labelledby={`${id}-permissions`}>
        <h3 id={`${id}-permissions`}>声明的应用能力</h3>
        <div className="plugin-install-permission-list">{manifest.permissions.length ? manifest.permissions.map(permission => <span key={permission} title={permission}>{permissionLabels[permission]}</span>) : <p>未声明应用能力</p>}</div>
        {manifest.backend ? <p className="plugin-install-permission-note">这些能力用于与 ModMind 交互，不代表插件的全部访问权限。</p> : null}
      </section>

      {conflictsWith ? <div className="plugin-install-replacement"><RefreshCw size={15} aria-hidden="true" /><p><strong>将替换已安装的版本</strong><span>{conflictsWith.scope === 'project' ? '当前项目' : '全局'}中的同名插件将被此版本替换。</span></p></div> : null}
    </div>

    <footer className="plugin-install-footer"><button ref={cancelRef} className="secondary-button" type="button" onClick={() => onResolve(false)}>取消</button><button className="primary-button" type="button" onClick={() => onResolve(true)}>信任并安装<ArrowRight size={15} aria-hidden="true" /></button></footer>
  </dialog>, document.body)
}

export function usePluginInstallDialog(): { confirmInstall: (preview: PluginImportPreview) => Promise<boolean>; installDialog: React.JSX.Element | null } {
  const [preview, setPreview] = useState<PluginImportPreview | null>(null)
  const resolver = useRef<((accepted: boolean) => void) | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; resolver.current?.(false); resolver.current = null }
  }, [])
  const confirmInstall = useCallback((next: PluginImportPreview): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false)
    return new Promise(resolve => { resolver.current?.(false); resolver.current = resolve; setPreview(next) })
  }, [])
  const onResolve = useCallback((accepted: boolean): void => {
    const resolve = resolver.current
    resolver.current = null
    setPreview(null)
    resolve?.(accepted)
  }, [])
  return { confirmInstall, installDialog: preview ? <PluginInstallDialog preview={preview} onResolve={onResolve} /> : null }
}
