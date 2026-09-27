import { useState } from 'react'
import { Check, CircleAlert, LoaderCircle, Workflow } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import type { ReleaseSettings } from '../../../shared/production'
import { reportClientFailure } from '../lib/clientFailure'
import { useReleaseDraft } from './useReleaseDraft'
import './workspace-tabs.css'

export default function BuildDeliverySettings({ project, onFilesChanged }: { project: ProjectInfo; onFilesChanged: () => void }): React.JSX.Element {
  const { settings, update, save, loading, error } = useReleaseDraft(project)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const run = async (operation: 'save' | 'ci'): Promise<void> => {
    setBusy(operation)
    setNotice('')
    try {
      if (operation === 'save') { await save(); setNotice('导出版本设置已保存') }
      else {
        const target = await window.modmind.production.tests.generateWorkflow()
        setNotice(`已生成 ${target}`)
        onFilesChanged()
      }
    } catch (reason) { setNotice(reportClientFailure(reason)) }
    finally { setBusy('') }
  }
  return <section className="build-delivery-settings">
    <div className="production-toolbar"><div><h2>版本与自动构建</h2><p>成功导出后递增下一次版本；发布到平台时不会自动递增。</p></div>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('ci')}>{busy === 'ci' ? <LoaderCircle className="spin" size={15} /> : <Workflow size={15} />}生成 CI</button></div>
    <fieldset className="release-edit-fields" disabled={loading || Boolean(busy) || Boolean(error)}><div className="release-form">
      <label>导出版本<input value={settings.version} onChange={event => update('version', event.target.value)} /></label>
      <label>递增方式<select value={settings.bumpMode ?? 'patch'} onChange={event => update('bumpMode', event.target.value as ReleaseSettings['bumpMode'])}><option value="patch">Patch</option><option value="minor">Minor</option><option value="major">Major</option></select></label>
      <label className="check-row"><input type="checkbox" checked={settings.autoBump !== false} onChange={event => update('autoBump', event.target.checked)} />导出成功后自动增加版本</label>
    </div><button className="primary-button" onClick={() => void run('save')}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存版本设置</button></fieldset>
    {error || notice ? <div className="production-notice" role="status"><CircleAlert size={14} />{error || notice}</div> : null}
  </section>
}
