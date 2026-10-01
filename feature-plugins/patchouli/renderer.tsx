import { LibraryBig } from 'lucide-react'
import PatchouliBookEditor from './components/PatchouliBookEditor'
import { modpack, registerFeature } from '../sdk/renderer'
registerFeature('patchouli', { apiVersion: 2, pages: [{ id: 'patchouli', label: 'Patchouli 指南书', group: '内容', icon: LibraryBig, supports: modpack, component: PatchouliBookEditor }] })
