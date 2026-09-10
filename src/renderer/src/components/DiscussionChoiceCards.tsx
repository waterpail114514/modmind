import { ArrowUpRight } from 'lucide-react'
import type { DiscussionChoice } from '../../../shared/discussionChoices'

export default function DiscussionChoiceCards({ choices, disabled, onSelect }: { choices: DiscussionChoice[]; disabled: boolean; onSelect: (choice: DiscussionChoice) => void }): React.JSX.Element | null {
  if (choices.length !== 3) return null
  return <div className="discussion-choice-cards" role="group" aria-label="选择下一步">
    {choices.map(choice => <button key={choice.label} type="button" disabled={disabled} title={choice.prompt} onClick={() => onSelect(choice)}><span>{choice.label}</span><ArrowUpRight size={15} aria-hidden="true" /></button>)}
  </div>
}
