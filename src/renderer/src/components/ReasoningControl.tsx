import { reasoningOptions } from '../../../shared/modelReasoning'
import type { BeginnerReasoningLevel, ModelReasoningCapabilities } from '../../../shared/types'

export default function ReasoningControl({ value, capabilities, disabled, onChange, compact = false }: {
  value: BeginnerReasoningLevel
  capabilities?: ModelReasoningCapabilities
  disabled?: boolean
  onChange?: (value: BeginnerReasoningLevel) => void
  compact?: boolean
}): React.JSX.Element {
  const options = reasoningOptions(capabilities)
  const valid = options.includes(value)
  return <div className={`reasoning-capability-control${compact ? ' compact' : ''}`}>
    <div className="reasoning-options" role="group" aria-label="思考强度">
      {!valid ? <button type="button" disabled aria-pressed="true">{value}（不可用）</button> : null}
      {options.map(effort => <button type="button" key={effort} aria-pressed={value === effort}
        disabled={disabled || !onChange} onClick={() => onChange?.(effort)}>{effort === 'auto' ? '自动' : effort}</button>)}
    </div>
    {!compact && !valid ? <small>原思考档位未获当前模型支持，请重新选择。</small> : null}
  </div>
}
