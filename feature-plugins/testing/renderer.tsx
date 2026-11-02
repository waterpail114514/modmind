import { Gamepad2, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isJavaLoader } from '../../src/shared/projectPlatform'
import WorkspaceTabs from '../../src/renderer/src/components/WorkspaceTabs'
import { registerFeature, routeData, type FeaturePageContext } from '../sdk/renderer'
import MinecraftTestWorkspace from './components/MinecraftTestWorkspace'
import ServerTestWorkspace from './components/ServerTestWorkspace'
import AutomatedTestsPane from './components/AutomatedTestsPane'
import QuickGameTestDialog from './components/QuickGameTestDialog'
import BackgroundGamePanel from './components/BackgroundGamePanel'

function TestingPage(context: FeaturePageContext): React.JSX.Element | null {
  const { project } = context
  const request = routeData<{ quickTest?: number }>(context)?.quickTest
  const [quick, setQuick] = useState(false)
  useEffect(() => { setQuick(false) }, [project?.path])
  useEffect(() => { if (request) setQuick(true) }, [request, project?.path])
  if (!project) return null
  const server = project.kind === 'server-plugin' || (context.routeData as { server?: boolean } | undefined)?.server
  const client = <MinecraftTestWorkspace projectPath={project.path} beginner={context.uiMode === 'beginner'} modpack={project.kind === 'modpack'} onManageRelationships={() => context.navigate(context.hasPage('relationships') ? 'relationships' : 'features')} />
  return <>
    {server ? project.kind === 'server-plugin' && ['paper', 'spigot', 'folia'].includes(project.loader) ? <WorkspaceTabs label="服务端测试" sections={[
      { id: 'server', label: '服务端', render: () => <ServerTestWorkspace project={project} /> },
      { id: 'background', label: '后台客户端', render: () => <BackgroundGamePanel project={project} /> }
    ]} /> : <ServerTestWorkspace project={project} /> : <WorkspaceTabs label="游戏测试" sections={[
      { id: 'play', label: '游戏测试', render: () => client },
      { id: 'background', label: '后台操控', render: () => <BackgroundGamePanel project={project} /> },
      ...(project.kind !== 'modpack' ? [{ id: 'checks', label: '自动检查', render: () => <AutomatedTestsPane /> }] : [])
    ]} />}
    {quick ? <QuickGameTestDialog project={project} onClose={() => setQuick(false)} onExport={() => context.exportArtifact()} /> : null}
  </>
}

function ServerTesting(context: FeaturePageContext): React.JSX.Element | null {
  return <TestingPage {...context} routeData={{ ...(context.routeData as object ?? {}), server: true }} />
}

registerFeature('testing', { apiVersion: 2, pages: [
  { id: 'minecraft', label: '游戏测试', group: '测试与构建', icon: Gamepad2, order: 10, keepAlive: true, supports: project => Boolean(project && project.kind !== 'server-plugin' && isJavaLoader(project.loader)), component: TestingPage },
  { id: 'modpack-server', label: '服务端测试', group: '测试与构建', icon: Server, order: 20, keepAlive: true, supports: project => Boolean(project && ['modpack', 'server-plugin'].includes(project.kind ?? '')), component: ServerTesting }
] })
