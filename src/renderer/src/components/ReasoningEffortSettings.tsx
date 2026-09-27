import { ChevronDown, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import { DEFAULT_CODEX_REASONING_EFFORTS, MAX_SELECTABLE_REASONING_EFFORTS, REASONING_EFFORTS } from '../../../shared/modelReasoning'
import type { ReasoningEffort } from '../../../shared/types'

export default function ReasoningEffortSettings({ value, disabled, onChange }: {
  value: ReasoningEffort[]
  disabled?: boolean
  onChange: (value: ReasoningEffort[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return <div className="reasoning-effort-settings">
    <button type="button" className="reasoning-effort-trigger" title="仅调整切换器选项，不会立即向模型发送请求"
      aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <strong>默认切换档位</strong><span>{value.join(' · ')}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open ? <div id={panelId} className="reasoning-effort-panel">
      <div role="group" aria-label="默认思考档位选项">
        {REASONING_EFFORTS.map(effort => <button key={effort} type="button" aria-pressed={value.includes(effort)}
          disabled={disabled || !value.includes(effort) && value.length >= MAX_SELECTABLE_REASONING_EFFORTS || value.includes(effort) && value.length === 1}
          title={!value.includes(effort) && value.length >= MAX_SELECTABLE_REASONING_EFFORTS ? '先取消一个档位' : undefined}
          onClick={() => onChange(REASONING_EFFORTS.filter(item => value.includes(effort) ? value.includes(item) && item !== effort : value.includes(item) || item === effort))}>{effort}</button>)}
      </div>
      {value.length !== DEFAULT_CODEX_REASONING_EFFORTS.length || value.some((effort, index) => effort !== DEFAULT_CODEX_REASONING_EFFORTS[index])
        ? <button type="button" className="secondary-button compact" disabled={disabled} onClick={() => onChange(DEFAULT_CODEX_REASONING_EFFORTS)}><RotateCcw size={13} />恢复默认</button> : null}
    </div> : null}
  </div>
}
