import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'
import ComposerAiControl from './ComposerAiControl'
import { selectedReasoningEfforts } from '../../../shared/modelReasoning'

export default function QuotaPreferenceControls({ preferences, models, disabled, managedCodex = true, onModelChange, onReasoningLevelChange, onReset }: {
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  disabled: boolean
  managedCodex?: boolean
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  return <ComposerAiControl model={preferences.model} effort={preferences.reasoningLevel} models={models}
    allowedEfforts={managedCodex ? selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions) : undefined}
    disabled={disabled} onModelChange={onModelChange} onEffortChange={onReasoningLevelChange} onReset={onReset} />
}
