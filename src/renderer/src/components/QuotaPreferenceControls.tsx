import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'
import ComposerAiControl from './ComposerAiControl'

export default function QuotaPreferenceControls({ preferences, models, disabled, onModelChange, onReasoningLevelChange, onReset }: {
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  disabled: boolean
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  return <ComposerAiControl model={preferences.model} effort={preferences.reasoningLevel} models={models} disabled={disabled} onModelChange={onModelChange} onEffortChange={onReasoningLevelChange} onReset={onReset} />
}
