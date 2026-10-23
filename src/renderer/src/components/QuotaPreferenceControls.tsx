import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'
import ComposerAiControl from './ComposerAiControl'
import { selectedReasoningEfforts } from '../../../shared/modelReasoning'
import type { QuotaModelSelection } from '../../../shared/quotaModels'
import type { CatalogProvider } from './ModelCatalogRows'

export default function QuotaPreferenceControls({ preferences, models, connectedProviders, scanning, disabled, managedCodex = true, onModelChange, onReasoningLevelChange, onReset, onRefresh, switching, message, onCancelWaiting }: {
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  connectedProviders?: CatalogProvider[]
  scanning?: boolean
  disabled: boolean
  managedCodex?: boolean
  onModelChange?: (model: string, selection?: QuotaModelSelection) => void
  onRefresh?: () => void
  switching?: boolean; message?: string
  onCancelWaiting?: () => void
  onReasoningLevelChange?: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  return <ComposerAiControl model={preferences.model} effort={preferences.reasoningLevel} models={models} connectedProviders={connectedProviders} scanning={scanning}
    allowedEfforts={managedCodex ? selectedReasoningEfforts(preferences.model, preferences.reasoningEffortOptions) : undefined}
    account={preferences.account} group={preferences.group} switching={switching} message={message} onCancelWaiting={onCancelWaiting} onRefresh={onRefresh} disabled={disabled} onModelChange={onModelChange} onEffortChange={onReasoningLevelChange} onReset={onReset} />
}
