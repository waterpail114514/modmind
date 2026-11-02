import type { AgentReasoningContent } from '../../../shared/types'
import { ReplyMarkdown } from './ReplyImages'
import AgentReasoningView from './AgentReasoningView'

/** Shared presentation; desktop and mobile provide their own safe Markdown renderer. */
export default function AgentReasoning(props: { reasoning?: AgentReasoningContent; running: boolean; expandWhileRunning?: boolean }): React.JSX.Element | null {
  return <AgentReasoningView {...props} renderContent={content=><ReplyMarkdown content={content} className="agent-markdown"/>}/>
}
