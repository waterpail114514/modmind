import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'
import ComposerAiControl from './ComposerAiControl'
import { selectedReasoningEfforts } from '../../../shared/modelReasoning'
import type { QuotaModelSelection } from '../../../shared/quotaModels'

export default function QuotaPreferenceControls({ preferences, models, disabled, managedCodex = true, onModelChange, onReasoningLevelChange, onReset, onRefresh, switching, message, onCancelWaiting }: {
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  disabled: boolean
  managedCodex?: boolean
  onModelChange?: (model: string, selection?: QuotaModelSelection) => void
  onRefresh?: () => void
  switching?: boolean; message?: string
  onCancelWaiting?: () => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  return <ComposerAiControl model={preferences.model} effort={preferences.reasoningLevel} models={models}
    allowedEfforts={managedCodex ? selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions) : undefined}
    account={preferences.account} switching={switching} message={message} onCancelWaiting={onCancelWaiting} onRefresh={onRefresh} disabled={disabled} onModelChange={onModelChange} onEffortChange={onReasoningLevelChange} onReset={onReset} />
}
