import { FileJson } from 'lucide-react'
import { javaMod, modpack, registerFeature } from '../sdk/renderer'
import DataPackWorkspace from './components/DataPackWorkspace'
registerFeature('data-packs', { apiVersion: 2, pages: [{ id: 'modpack-datapacks', label: '数据包', group: '内容', order: 40, icon: FileJson, supports: project => javaMod(project) || modpack(project), keepAlive: true, component: context => context.project ? <DataPackWorkspace key={context.project.path} project={context.project} onFilesChanged={context.filesChanged} onTest={() => context.navigate('minecraft')} /> : null }] })
