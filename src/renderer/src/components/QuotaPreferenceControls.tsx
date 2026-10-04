import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel, CodingBackend } from '../../../shared/types'
import ComposerAiControl from './ComposerAiControl'
import { selectedReasoningEfforts } from '../../../shared/modelReasoning'

export default function QuotaPreferenceControls({ preferences, models, disabled, managedCodex = true, backend, onModelChange, onReasoningLevelChange, onReset }: {
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  disabled: boolean
  managedCodex?: boolean
  backend?: CodingBackend
  onModelChange?: (model: string) => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  return <ComposerAiControl model={preferences.model} effort={preferences.reasoningLevel} models={models}
    allowedEfforts={managedCodex ? selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions) : undefined}
    backend={backend} disabled={disabled} onModelChange={onModelChange} onEffortChange={onReasoningLevelChange} onReset={onReset} />
}
