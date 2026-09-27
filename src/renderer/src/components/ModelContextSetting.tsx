import { useId, useState } from 'react'
import { validModelContext } from '../../../shared/modelContext'

interface Props {
  model: string
  value?: number
  compactValue?: number
  saving: boolean
  onSave: (value: number | undefined, compactValue: number | undefined) => void
}

export default function ModelContextSetting({ model, value, compactValue, saving, onSave }: Props): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [compactDraft, setCompactDraft] = useState(compactValue === undefined ? '' : String(compactValue))
  const [error, setError] = useState('')
  const save = (): void => {
    const text = draft.trim()
    const compactText = compactDraft.trim()
    if (text && (!/^\d+$/.test(text) || !validModelContext(Number(text)))) {
      setError('请输入 1,024–100,000,000 之间的整数，或留空使用自动设置')
      return
    }
    if (compactText && (!/^\d+$/.test(compactText) || !validModelContext(Number(compactText)))) {
      setError('自动压缩阈值请输入 1,024–100,000,000 之间的整数')
      return
    }
    if (text && compactText && Number(compactText) > Math.floor(Number(text) * 0.9)) {
      setError('自动压缩阈值不能超过上下文窗口的 90%')
      return
    }
    setError('')
    onSave(text ? Number(text) : undefined, compactText ? Number(compactText) : undefined)
  }
  return <form className="model-context-setting" onSubmit={event => { event.preventDefault(); save() }}>
    <div className="field-label">
      <label htmlFor={id}>模型上下文窗口（tokens）</label>
      <input id={id} type="text" inputMode="numeric" value={draft} disabled={saving || !model}
        placeholder="自动匹配"
        aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setDraft(event.target.value); setError('') }} />
    </div>
    <div className="field-label">
      <label htmlFor={`${id}-compact`}>自动压缩阈值（tokens）</label>
      <input id={`${id}-compact`} type="text" inputMode="numeric" value={compactDraft} disabled={saving || !model}
        placeholder="自动计算" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setCompactDraft(event.target.value); setError('') }} />
    </div>
    <div className="settings-actions">
      <div className="settings-button-group">
        <button type="button" className="secondary-button compact" disabled={saving || value === undefined && compactValue === undefined}
          onClick={() => { setDraft(''); setCompactDraft(''); setError(''); onSave(undefined, undefined) }}>恢复自动</button>
        <button type="submit" className="primary-button compact" disabled={saving || !model || draft.trim() === (value === undefined ? '' : String(value)) && compactDraft.trim() === (compactValue === undefined ? '' : String(compactValue))}>{saving ? '正在保存…' : '保存模型设置'}</button>
      </div>
    </div>
    {error ? <p id={`${id}-error`} role="alert">{error}</p> : null}
  </form>
}
