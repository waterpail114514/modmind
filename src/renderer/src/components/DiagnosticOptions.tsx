import { useState } from 'react'
import type { DiagnosticAttachment, DiagnosticExportOptions } from '../../../shared/diagnostics'
import { reportClientFailure } from '../lib/clientFailure'

export default function DiagnosticOptions({ options, onChange }: { options: DiagnosticExportOptions; onChange: (options: DiagnosticExportOptions) => void }): React.JSX.Element {
  const [attachments, setAttachments] = useState<DiagnosticAttachment[]>([])
  const [error, setError] = useState('')
  const update = (patch: Partial<DiagnosticExportOptions>) => onChange({ ...options, ...patch })
  return <details className="diagnostic-options">
    <summary>补充问题信息与附件</summary>
    <div className="diagnostic-options-fields">
      <label className="field-label">遇到了什么问题<textarea maxLength={8000} rows={3} value={options.description ?? ''} placeholder="发生了什么、预期是什么、如何重现" onChange={event => update({ description: event.target.value })} /></label>
      <label className="field-label">发生时间<input type="datetime-local" value={options.occurredAt ?? ''} onChange={event => update({ occurredAt: event.target.value })} /></label>
      <label><input type="checkbox" checked={options.includeScreenshot === true} onChange={event => update({ includeScreenshot: event.target.checked })} />附当前窗口画面</label>
      <label><input type="checkbox" checked={options.includeProjectFiles === true} onChange={event => update({ includeProjectFiles: event.target.checked })} />附项目源码与资源定义</label>
      <label><input type="checkbox" checked={options.includeCrashDumps === true} onChange={event => update({ includeCrashDumps: event.target.checked })} />附本地崩溃转储（可能含内存中的私人内容）</label>
      <div className="settings-actions"><button type="button" className="secondary-button compact" onClick={() => { void window.modmind.diagnostics.pickAttachments().then(files => { setAttachments(files); update({ attachmentIds: files.map(file => file.id) }); setError('') }).catch(failure => setError(reportClientFailure(failure))) }}>选择日志、账单或原始文件</button>{attachments.length ? <button type="button" className="secondary-button compact" onClick={() => { setAttachments([]); update({ attachmentIds: [] }) }}>移除附件</button> : null}</div>
      {attachments.length ? <ul>{attachments.map(file => <li key={file.id}>{file.name} · {Math.ceil(file.bytes / 1024)} KiB</li>)}</ul> : null}
      <p>导出会包含诊断记录、项目配置、对话证据和已有测试截图。选取的图片、PDF 与 ZIP 附件会原样附上，请先去掉私人信息。</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </details>
}
