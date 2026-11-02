import { Code2, FileCog, FileJson, FolderOpen, Globe2, LayoutTemplate, ListTree, ServerCog, SlidersHorizontal, Sparkles } from 'lucide-react'
import ModpackContentWorkspace from './components/ModpackContentWorkspace'
import ModpackKeybindWorkspace from './components/ModpackKeybindWorkspace'
import { modpack, registerFeature, type FeaturePageContext } from '../sdk/renderer'
import type { FeaturePageDefinition } from '../../src/renderer/src/featurePluginTypes'
const definitions = [
  ['modpack-manifest', '文件清单', 'other', ListTree],
  ['modpack-config', '配置与默认项', 'config', FileCog],
  ['modpack-scripts', '脚本与 KubeJS', 'scripts', Code2],
  ['modpack-shaders', '光影包', 'shaderpacks', Sparkles],
  ['modpack-ui', '界面资源', 'ui', LayoutTemplate],
  ['modpack-worlds', '存档与世界', 'worlds', Globe2],
  ['modpack-server-content', '服务端配置', 'server', ServerCog],
  ['modpack-files', '文件工作台', 'other', FolderOpen]
] as const
const pages: FeaturePageDefinition[] = definitions.map(([id, label, section, icon]) => ({
  id, label, group: '内容', icon, supports: modpack,
  component: (context: FeaturePageContext) => context.project ? <ModpackContentWorkspace project={context.project} darkMode={context.darkMode} section={section} inventoryMode={id === 'modpack-manifest'} onOpenEditor={context.openFile} onCreateFile={context.createFile} /> : null
}))
pages.push({ id: 'modpack-client', label: '玩家预设', group: '内容', icon: SlidersHorizontal, supports: modpack, component: context => context.project ? <ModpackKeybindWorkspace project={context.project} onOpenRaw={context.openFile} /> : null })
registerFeature('modpack-content', { apiVersion: 2, pages })
