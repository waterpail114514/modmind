import { useState } from 'react'
import { PackagePlus, RotateCcw } from 'lucide-react'
import { refreshFeaturePlugins, useFeaturePlugins } from '../featurePlugins'
import { useConfirmDialog } from './InteractionDialogs'
import './feature-plugin-settings.css'

export default function FeaturePluginSettings(): React.JSX.Element {
  const { records, catalog, ready, error } = useFeaturePlugins()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const { confirm, dialog } = useConfirmDialog()
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setNotice('')
    try { await operation(); await refreshFeaturePlugins() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const change = async (id: string, name: string, remove: boolean): Promise<void> => {
    if (!await confirm({ title: `${remove ? '卸载' : '停用'}${name}？`, message: '请先保存正在编辑的内容。已保存的项目文件与插件设置会保留。', confirmLabel: remove ? '卸载插件' : '停用插件', tone: remove ? 'danger' : 'default' })) return
    await run(() => remove ? window.modmind.featurePlugins.uninstall(id) : window.modmind.featurePlugins.setEnabled(id, false))
  }
  return <>
    <div className="settings-heading"><h2>应用功能插件</h2></div>
    <div className="settings-actions"><button className="secondary-button compact" disabled={busy} onClick={() => void run(() => window.modmind.featurePlugins.install())}><PackagePlus size={15} />安装功能插件</button><button className="secondary-button compact" disabled={busy} onClick={() => void run(refreshFeaturePlugins)}><RotateCcw size={14} />刷新</button></div>
    {!ready ? <p role="status">正在读取插件…</p> : !records.length ? <p>尚未安装应用功能插件</p> : null}
    {records.map(record => <div key={record.id} className="feature-plugin-row">
      <div className="feature-plugin-info"><strong>{record.name}</strong><span>{record.version} · {record.error ? '加载失败' : catalog.find(entry => entry.id === record.id)?.state === 'dependency-missing' ? `需安装或启用：${(record.manifest?.dependencies ?? []).filter(id => !catalog.find(entry => entry.id === id)?.available).map(id => catalog.find(entry => entry.id === id)?.name ?? id).join('、')}` : record.enabled ? '已启用' : '已停用'}</span></div>
      {record.error && <p role="alert">{record.error}</p>}
      {record.builtin ? <span>内置</span> : <div className="feature-plugin-actions"><button className="secondary-button compact" disabled={busy} onClick={() => record.enabled ? void change(record.id, record.name, false) : void run(() => window.modmind.featurePlugins.setEnabled(record.id, true))}>{record.enabled ? '停用' : '启用'}</button><button className="secondary-button compact danger" disabled={busy} onClick={() => void change(record.id, record.name, true)}>卸载</button></div>}
    </div>)}
    {ready && catalog.some(entry => !entry.installed) && <details><summary>可安装功能</summary>{catalog.filter(entry => !entry.installed).map(entry => <div className="feature-plugin-row" key={entry.id}><div className="feature-plugin-info"><strong>{entry.name}</strong><span>未安装</span></div></div>)}</details>}
    {(notice || error) && <p role="alert">{notice || error}</p>}
    {dialog}
  </>
}
