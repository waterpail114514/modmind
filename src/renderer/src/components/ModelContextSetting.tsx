import { useId, useState } from 'react'
import { validModelContext } from '../../../shared/modelContext'

interface Props {
  model: string
  value?: number
  saving: boolean
  onSave: (value: number | undefined) => void
}

export default function ModelContextSetting({ model, value, saving, onSave }: Props): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [error, setError] = useState('')
  const save = (): void => {
    const text = draft.trim()
    if (text && (!/^\d+$/.test(text) || !validModelContext(Number(text)))) {
      setError('请输入 1,024–100,000,000 之间的整数，或留空使用自动设置')
      return
    }
    setError('')
    onSave(text ? Number(text) : undefined)
  }
  return <form className="model-context-setting" onSubmit={event => { event.preventDefault(); save() }}>
    <div className="field-label">
      <label htmlFor={id}>模型上下文窗口（tokens）</label>
      <input id={id} type="text" inputMode="numeric" value={draft} disabled={saving || !model}
        placeholder="自动匹配；未知模型默认 512K"
        aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={event => { setDraft(event.target.value); setError('') }} />
      <small id={`${id}-help`}>仅对当前线路的 {model} 生效。手动值优先于自动设置，并用于实际执行和自动压缩；留空恢复自动。</small>
    </div>
    <div className="settings-actions">
      <span>{value === undefined ? '当前使用自动设置' : `已设置 ${value.toLocaleString('zh-CN')} tokens`}</span>
      <button type="button" className="secondary-button compact" disabled={saving || value === undefined}
        onClick={() => { setDraft(''); setError(''); onSave(undefined) }}>恢复自动</button>
      <button type="submit" className="primary-button compact" disabled={saving || !model || draft.trim() === (value === undefined ? '' : String(value))}>{saving ? '正在保存…' : '保存上下文设置'}</button>
    </div>
    {error ? <p id={`${id}-error`} role="alert">{error}</p> : null}
  </form>
}
