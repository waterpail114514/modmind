import { ChevronDown } from 'lucide-react'
import type { BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'

export default function QuotaPreferenceControls({ preferences, models, disabled, onModelChange, onReasoningLevelChange }: {
  preferences: BeginnerAiPreferences
  models: Array<{ id: string }>
  disabled: boolean
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
}): React.JSX.Element {
  const options = [...new Set([preferences.model, ...models.map(model => model.id)])]
  return <div className="minimal-quota-preferences">
    <label><select aria-label="模型" title={preferences.model} value={preferences.model} disabled={disabled || !onModelChange} onChange={event => onModelChange?.(event.target.value)}>
      {options.map(model => <option key={model} value={model}>{model}</option>)}
    </select><ChevronDown size={12} aria-hidden="true" /></label>
    <label className="minimal-reasoning"><select aria-label="思考强度" title="强度越高，推理更充分，额度消耗也更高" value={preferences.reasoningLevel} disabled={disabled || !onReasoningLevelChange} onChange={event => onReasoningLevelChange?.(event.target.value as BeginnerReasoningLevel)}>
      {([['low', '低'], ['medium', '中'], ['high', '高'], ['extreme', '极高']] as const).map(([value, label]) => <option key={value} value={value}>思考：{label}</option>)}
    </select><ChevronDown size={12} aria-hidden="true" /></label>
  </div>
}
