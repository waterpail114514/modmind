import { useEffect, useState } from 'react'
import { marked } from 'marked'
import {
  BookOpen,
  Bug,
  Check,
  Download,
  Eraser,
  ExternalLink,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  PackagePlus,
  Play,
  Puzzle,
  RefreshCw,
  RotateCw,
  Terminal,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type { PluginDiagnostics, PluginRecord, PluginSnapshot } from '../../../shared/plugins'
import pluginDevelopmentDocument from '../../../../docs/plugin-development.zh-CN.md?raw'

interface PluginsManagerProps {
  snapshot: PluginSnapshot
  hasProject: boolean
  onRefresh: () => void
  onOpenPanel: (pluginId: string) => void
  confirmDelete: (pluginId: string, pluginName: string) => Promise<boolean>
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

const pluginDocumentationHtml = (() => {
  const renderer = new marked.Renderer()
  renderer.html = ({ text }) => escapeHtml(text)
  renderer.link = ({ href, text }) => {
    const safeText = escapeHtml(text)
    if (!/^https?:\/\//i.test(href)) return safeText
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${safeText}</a>`
  }
  return marked.parse(pluginDevelopmentDocument, { async: false, gfm: true, breaks: true, renderer }) as string
})()

const runtimeStatusLabels: Record<PluginDiagnostics['status'], string> = {
  idle: '尚未启动',
  starting: '正在启动',
  running: '运行中',
  stopped: '已停止',
  failed: '启动失败'
}

/**
 * 插件管理页：列表、启停、导入、导出、删除与制作文档。
 * 独立于设置页，避免设置分区膨胀。
 */
export function PluginsManager({ snapshot, hasProject, onRefresh, onOpenPanel, confirmDelete }: PluginsManagerProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const [docDownloaded, setDocDownloaded] = useState(false)
  const [docDownloading, setDocDownloading] = useState(false)
  const [docToast, setDocToast] = useState<string | null>(null)
  const [developerPlugin, setDeveloperPlugin] = useState<PluginRecord | null>(null)
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostics | null>(null)
  const [developerBusy, setDeveloperBusy] = useState(false)

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (!docToast) return
    const timer = setTimeout(() => setDocToast(null), 3500)
    return () => clearTimeout(timer)
  }, [docToast])

  useEffect(() => window.modmind.plugins.onDiagnosticsChanged((next) => {
    if (next.pluginId === developerPlugin?.manifest.id) setDiagnostics(next)
  }), [developerPlugin?.manifest.id])

  const openDeveloper = async (plugin: PluginRecord): Promise<void> => {
    setDeveloperPlugin(plugin)
    setDeveloperBusy(true)
    try {
      setDiagnostics(await window.modmind.plugins.diagnostics(plugin.manifest.id))
      if (plugin.manifest.backend && plugin.enabled && !plugin.error) {
        setDiagnostics(await window.modmind.plugins.activate(plugin.manifest.id))
      }
    } catch (error) {
      setMessage(`失败：${error instanceof Error ? error.message : String(error)}`)
      setDiagnostics(await window.modmind.plugins.diagnostics(plugin.manifest.id).catch(() => null))
    } finally {
      setDeveloperBusy(false)
    }
  }

  const restartDeveloperPlugin = async (): Promise<void> => {
    if (!developerPlugin?.manifest.backend) return
    setDeveloperBusy(true)
    try {
      setDiagnostics(await window.modmind.plugins.restart(developerPlugin.manifest.id))
    } catch (error) {
      setMessage(`失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDeveloperBusy(false)
    }
  }

  const downloadDoc = async (): Promise<void> => {
    if (docDownloading) return
    setDocDownloading(true)
    try {
      await window.modmind.plugins.exportDoc(pluginDevelopmentDocument)
      setDocDownloaded(true)
      setDocToast('已保存到「下载」文件夹')
      setTimeout(() => setDocDownloaded(false), 2500)
    } catch (error) {
      setDocToast(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDocDownloading(false)
    }
  }

  const runAction = async (action: () => Promise<boolean | void>, label: string): Promise<void> => {
    setBusy(true)
    try {
      const completed = await action()
      if (completed === false) return
      setMessage(label)
      onRefresh()
    } catch (error) {
      setMessage(`失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const plugins = [...snapshot.plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  const enabledCount = plugins.filter((plugin) => plugin.enabled && !plugin.error).length
  const panelCount = plugins.filter((plugin) => plugin.manifest.panel || plugin.manifest.overlay).length
  const toolCount = plugins.reduce((total, plugin) => total + (plugin.manifest.backend?.tools.length ?? 0), 0)

  return (
    <div className="settings-page plugins-page">
      <div className="content-toolbar">
        <div>
          <h1>插件</h1>
          <p>管理完全可信的本机 Node 扩展与沙箱面板；保存文件即自动热重载</p>
        </div>
        <div className="plugins-toolbar-actions">
          <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void window.modmind.plugins.openDirectory()}>
            <FolderOpen size={14} /> 打开插件目录
          </button>
          <button className="secondary-button compact" type="button" disabled={busy || !hasProject} title={hasProject ? undefined : '打开项目后可安装到当前项目'} onClick={() => void runAction(async () => !('cancelled' in await window.modmind.plugins.importZip('project')), '已导入到当前项目')}>
            <PackagePlus size={14} /> 导入到项目
          </button>
          <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void runAction(async () => !('cancelled' in await window.modmind.plugins.importZip('global')), '已导入到全局')}>
            <PackagePlus size={14} /> 导入到全局
          </button>
          <span className="plugins-toolbar-divider" />
          <span className="plugins-toolbar-icons">
            <button className="icon-button" type="button" title="插件制作文档" onClick={() => setDocsOpen(true)}>
              <BookOpen size={15} />
            </button>
            <button className="icon-button" type="button" title="重新扫描" disabled={busy} onClick={() => void runAction(async () => { await window.modmind.plugins.reload() }, '已重新扫描')}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
          </span>
        </div>
      </div>

      <div className="plugin-trust-banner">
        <span>后端插件拥有完整 Node 权限，可读写本机文件、联网和启动进程。只安装并启用你完全信任的插件。</span>
      </div>

      {plugins.length === 0 ? (
        <div className="large-empty plugin-empty">
          <Puzzle size={26} />
          <h3>还没有安装任何插件</h3>
          <div className="plugin-empty-actions">
            <button className="secondary-button compact" type="button" onClick={() => void window.modmind.plugins.openDirectory()}><FolderOpen size={14} />打开插件目录</button>
            <button className="secondary-button compact" type="button" onClick={() => setDocsOpen(true)}><BookOpen size={14} />查看制作文档</button>
          </div>
          <p className="plugin-empty-hint">也可以在工作台直接让 AI 帮你做一个插件</p>
        </div>
      ) : (
        <>
          <div className="plugin-stats">
            <div className="plugin-stat"><strong>{plugins.length}</strong><span>已安装</span></div>
            <div className="plugin-stat"><strong>{enabledCount}</strong><span>已启用</span></div>
            <div className="plugin-stat"><strong>{panelCount}</strong><span>界面插件</span></div>
            <div className="plugin-stat"><strong>{toolCount}</strong><span>MCP 工具</span></div>
          </div>

          {message ? <div className={`plugin-toast ${message.startsWith('失败') ? 'error' : ''}`}>{message}</div> : null}

          <div className="plugin-grid">
            {plugins.map((plugin) => (
              <article className={`plugin-card${plugin.error || plugin.runtimeError ? ' has-error' : ''}${plugin.enabled && !plugin.error && !plugin.runtimeError ? ' enabled' : ''}`} key={`${plugin.scope}:${plugin.manifest.id}`}>
                <header className="plugin-card-head">
                  <div className="plugin-card-title">
                    {plugin.manifest.icon ? (
                      <img className="plugin-card-icon" src={`modmind-plugin://${plugin.manifest.id}/${plugin.manifest.icon}?revision=${plugin.revision ?? 0}`} alt="" />
                    ) : <span className={`status-dot ${plugin.error || plugin.runtimeError ? 'warning' : plugin.enabled ? 'success' : ''}`} />}
                    <div>
                      <strong>{plugin.manifest.name}</strong>
                      <small>
                        {plugin.manifest.id} · v{plugin.manifest.version} · {plugin.scope === 'project' ? '项目级' : '全局'}
                      </small>
                    </div>
                  </div>
                  <label className="plugin-switch" title={plugin.enabled ? '停用插件' : '启用插件'}>
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      disabled={busy}
                      onChange={(event) => void runAction(async () => { await window.modmind.plugins.setEnabled(plugin.manifest.id, event.target.checked) }, plugin.enabled ? '已停用' : '已启用')}
                    />
                    <span className="plugin-switch-track"><span className="plugin-switch-thumb" /></span>
                  </label>
                </header>
                {plugin.error || plugin.runtimeError ? (
                  <p className="plugin-card-error">{plugin.error ?? `后端启动失败：${plugin.runtimeError}`}</p>
                ) : (
                  <div className="plugin-card-tags">
                    {plugin.manifest.panel ? <span className="plugin-tag"><LayoutDashboard size={11} />面板</span> : null}
                    {plugin.manifest.overlay ? <span className="plugin-tag"><ExternalLink size={11} />跨页面悬浮</span> : null}
                    {plugin.manifest.backend?.tools.length ? <span className="plugin-tag"><Wrench size={11} />{plugin.manifest.backend.tools.length} 个工具</span> : null}
                    {!plugin.manifest.panel && !plugin.manifest.overlay && !plugin.manifest.backend?.tools.length ? <span className="plugin-tag">无界面或工具</span> : null}
                  </div>
                )}
                <footer className="plugin-card-actions">
                  <div className="plugin-card-primary-actions">
                    {!plugin.error && plugin.manifest.panel ? (
                      <button className="secondary-button compact" type="button" onClick={() => onOpenPanel(plugin.manifest.id)}>打开面板</button>
                    ) : null}
                    {!plugin.error && plugin.enabled && plugin.manifest.overlay ? (
                      <button className="secondary-button compact" type="button" onClick={() => void runAction(async () => { await window.modmind.plugins.openOverlayWindow(plugin.manifest.id) }, '悬浮窗已弹到桌面')}>
                        <ExternalLink size={13} />弹到桌面
                      </button>
                    ) : null}
                  </div>
                  <div className="plugin-card-icon-actions">
                    <button className="icon-button" type="button" title="开发者控制台" disabled={busy} onClick={() => void openDeveloper(plugin)}>
                      <Bug size={15} />
                    </button>
                    <button className="icon-button" type="button" title="导出 .zip 分享" disabled={busy} onClick={() => void runAction(async () => Boolean(await window.modmind.plugins.export(plugin.manifest.id)), '已导出')}>
                      <PackagePlus size={15} />
                    </button>
                    <button className="icon-button danger" type="button" title="删除插件" disabled={busy} onClick={() => void (async () => {
                      if (!await confirmDelete(plugin.manifest.id, plugin.manifest.name)) return
                      await runAction(async () => { await window.modmind.plugins.delete(plugin.manifest.id) }, '已删除')
                    })()}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
        </>
      )}

      {docsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDocsOpen(false)}>
          <div className="dialog plugin-docs-dialog" role="dialog" aria-modal="true" aria-label="插件制作文档" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-header plugin-docs-dialog-header">
              <div>
                <h2>插件制作文档</h2>
                <p>从模板开始创建面板或 MCP 工具插件</p>
              </div>
              <div className="plugin-docs-dialog-actions">
                <button className={`icon-button${docDownloaded ? ' success' : ''}`} type="button" title={docDownloaded ? '已保存到「下载」文件夹' : '下载文档到「下载」文件夹'} disabled={docDownloading} onClick={() => void downloadDoc()}>
                  {docDownloading ? <LoaderCircle className="spin" size={16} /> : docDownloaded ? <Check size={16} /> : <Download size={16} />}
                </button>
                <button className="icon-button" type="button" title="关闭" onClick={() => setDocsOpen(false)}>
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="plugin-docs-content markdown-message" dangerouslySetInnerHTML={{ __html: pluginDocumentationHtml }} />
          </div>
        </div>
      ) : null}

      {developerPlugin ? (
        <div className="plugin-developer-backdrop" role="presentation" onMouseDown={() => setDeveloperPlugin(null)}>
          <aside className="plugin-developer-drawer" role="dialog" aria-modal="true" aria-label={`${developerPlugin.manifest.name} 开发者控制台`} onMouseDown={(event) => event.stopPropagation()}>
            <header className="plugin-developer-header">
              <div>
                <h2><Terminal size={17} />{developerPlugin.manifest.name}</h2>
                <p>{developerPlugin.manifest.id} · {diagnostics ? runtimeStatusLabels[diagnostics.status] : '正在读取状态'}{diagnostics?.pid ? ` · PID ${diagnostics.pid}` : ''}</p>
              </div>
              <button className="icon-button" type="button" title="关闭" onClick={() => setDeveloperPlugin(null)}><X size={17} /></button>
            </header>

            <div className="plugin-developer-actions">
              {developerPlugin.manifest.backend ? (
                <>
                  <button className="secondary-button compact" type="button" disabled={developerBusy || diagnostics?.status === 'running'} onClick={() => void openDeveloper(developerPlugin)}>
                    {developerBusy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}启动
                  </button>
                  <button className="secondary-button compact" type="button" disabled={developerBusy} onClick={() => void restartDeveloperPlugin()}><RotateCw size={14} />重启</button>
                </>
              ) : null}
              <button className="secondary-button compact" type="button" disabled={!diagnostics?.logs.length} onClick={() => void window.modmind.plugins.clearDiagnostics(developerPlugin.manifest.id).then(setDiagnostics)}><Eraser size={14} />清空</button>
              <button className="secondary-button compact" type="button" onClick={() => void window.modmind.plugins.openDirectory()}><FolderOpen size={14} />插件目录</button>
            </div>

            {diagnostics?.error ? <div className="plugin-developer-error">{diagnostics.error}</div> : null}
            <div className="plugin-developer-meta">
              <span>入口：{developerPlugin.manifest.backend?.entry ?? developerPlugin.manifest.overlay?.entry ?? developerPlugin.manifest.panel?.entry ?? '无'}</span>
              <span>权限：{developerPlugin.manifest.permissions.join(', ') || '无'}</span>
              {diagnostics?.startedAt ? <span>启动：{new Date(diagnostics.startedAt).toLocaleString()}</span> : null}
              {diagnostics?.exitCode !== undefined ? <span>退出码：{diagnostics.exitCode}</span> : null}
            </div>

            <div className="plugin-developer-console" role="log" aria-live="polite">
              {diagnostics?.logs.length ? diagnostics.logs.map((entry) => (
                <div className={`plugin-console-line ${entry.level}`} key={entry.id}>
                  <time>{new Date(entry.time).toLocaleTimeString()}</time>
                  <span className="plugin-console-source">{entry.source}</span>
                  <pre>{entry.message}</pre>
                </div>
              )) : <div className="plugin-console-empty">暂无日志</div>}
            </div>
          </aside>
        </div>
      ) : null}

      {docToast ? <div className="plugin-doc-toast">{docToast}</div> : null}
    </div>
  )
}
