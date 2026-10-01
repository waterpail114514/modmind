import { BookOpen } from 'lucide-react'
import FtbQuestEditor from './components/FtbQuestEditor'
import { modpack, registerFeature, type FeaturePageContext } from '../sdk/renderer'
function Quests(context: FeaturePageContext): React.JSX.Element | null { return context.project ? <FtbQuestEditor project={context.project} /> : null }
registerFeature('ftb-quests', { apiVersion: 2, pages: [{ id: 'ftb-quests', label: 'FTB 任务书', group: '内容', icon: BookOpen, supports: modpack, className: 'ftb-quest-host', component: Quests }] })
