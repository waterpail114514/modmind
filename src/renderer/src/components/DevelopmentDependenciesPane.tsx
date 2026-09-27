import { useEffect, useState } from 'react'
import { Check, CircleAlert, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { ManagedDependency } from '../../../shared/production'
import { reportClientFailure as errorMessage } from '../lib/clientFailure'
import { useConfirmDialog } from './InteractionDialogs'

export default function DevelopmentDependenciesPane({ onFilesChanged, active = true }: { onFilesChanged: () => void; active?: boolean }): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const [managed, setManaged] = useState<ManagedDependency[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [mavenCoordinate, setMavenCoordinate] = useState('')
  const [mavenRepository, setMavenRepository] = useState('')
  const [mavenConfiguration, setMavenConfiguration] = useState<'implementation' | 'modImplementation' | 'compileOnly' | 'runtimeOnly'>('implementation')

  const refresh = async (): Promise<void> => setManaged((await window.modmind.production.dependencies.list()).filter(entry => !entry.relationshipId))

  useEffect(() => {
    if (active) void refresh().catch((error) => setNotice(errorMessage(error)))
  }, [active])

  const install = async (dependencyProject: ManagedDependency): Promise<void> => {
    setBusy(dependencyProject.projectId)
    setNotice('')
    try {
      const installed = await window.modmind.production.dependencies.install({ projectId: dependencyProject.projectId })
      await refresh()
      onFilesChanged()
      setNotice(`已安装 ${installed.name} ${installed.versionNumber}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const remove = async (dependency: ManagedDependency): Promise<void> => {
    if (!await requestConfirm({ title: `移除依赖“${dependency.name}”？`, message: '将同步更新 Gradle、项目依赖目录和测试实例', confirmLabel: '移除依赖', tone: 'danger' })) return
    setBusy(dependency.projectId)
    setNotice('')
    try {
      await window.modmind.production.dependencies.remove(dependency.projectId)
      await refresh()
      onFilesChanged()
      setNotice(`已移除 ${dependency.name}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const installMaven = async (): Promise<void> => {
    if (!mavenCoordinate.trim() || busy) return
    setBusy('maven')
    setNotice('')
    try {
      const installed = await window.modmind.production.dependencies.installMaven({
        coordinate: mavenCoordinate,
        repository: mavenRepository,
        configuration: mavenConfiguration
      })
      await refresh()
      onFilesChanged()
      setNotice(`已添加 Maven 依赖 ${installed.coordinate}`)
      setMavenCoordinate('')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const auditDependencies = async (): Promise<void> => {
    setBusy('audit')
    setNotice('')
    try {
      const audit = await window.modmind.production.dependencies.audit()
      const details = [...audit.errors, ...audit.warnings]
      setNotice(`${audit.success ? '依赖锁定检查通过' : '依赖锁定检查失败'}：${audit.checked} 项${details.length ? `；${details.join('；')}` : ''}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  return <div className="production-pane dependency-pane">
    <div className="production-toolbar"><div><h2>开发依赖</h2><p>Maven 库与旧版受管依赖。添加模组请使用“前置与联动”。</p></div></div>
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    <section className="maven-dependency-form">
      <div className="maven-dependency-copy"><h3>Maven 坐标</h3><p>仓库地址仅支持 HTTPS</p></div>
      <label className="maven-field">坐标<input value={mavenCoordinate} onChange={(event) => setMavenCoordinate(event.target.value)} placeholder="group:artifact:version" /></label>
      <label className="maven-field">仓库地址<input value={mavenRepository} onChange={(event) => setMavenRepository(event.target.value)} placeholder="https://repo.example.com/releases（可选）" /></label>
      <label className="maven-field">依赖配置<select value={mavenConfiguration} onChange={(event) => setMavenConfiguration(event.target.value as typeof mavenConfiguration)}>
        <option value="implementation">implementation</option>
        <option value="modImplementation">modImplementation</option>
        <option value="compileOnly">compileOnly</option>
        <option value="runtimeOnly">runtimeOnly</option>
      </select></label>
      <button className="secondary-button" disabled={!mavenCoordinate.trim() || Boolean(busy)} onClick={() => void installMaven()}>{busy === 'maven' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}添加 Maven</button>
    </section>
    <section className="managed-dependencies">
      <div className="section-title-row"><h2>项目依赖</h2><span>{managed.length} 项</span><button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void auditDependencies()}>{busy === 'audit' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}审计锁文件</button></div>
      {managed.length ? managed.map((dependency) => <div className="managed-dependency-row" key={dependency.projectId}>
        <span className="dependency-mark"><Check size={14} /></span>
        <div><strong>{dependency.name}</strong><small>{dependency.versionNumber} · {dependency.source === 'maven' ? dependency.configuration : dependency.environment === 'both' ? '客户端与服务端' : dependency.environment === 'client' ? '仅客户端' : '仅服务端'}</small></div>
        <code>{dependency.source === 'maven' ? dependency.coordinate : dependency.fileName}</code>
        <div className="dependency-row-actions">{dependency.source === 'modrinth' ? <button className="icon-button" title="更新依赖" disabled={Boolean(busy)} onClick={() => void install(dependency)}><RefreshCw size={14} /></button> : null}<button className="icon-button" title="移除依赖" disabled={Boolean(busy)} onClick={() => void remove(dependency)}>{busy === dependency.projectId ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div>
      </div>) : <div className="inline-empty">尚未添加受管依赖</div>}
    </section>
    {confirmDialog}
  </div>
}

