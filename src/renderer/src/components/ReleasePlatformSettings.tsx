import { useState } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import { reportClientFailure } from '../lib/clientFailure'
import { SecretInput } from './SecretInput'
import { useReleaseDraft } from './useReleaseDraft'
import './workspace-tabs.css'

export default function ReleasePlatformSettings({ project }: { project: ProjectInfo }): React.JSX.Element {
  const { settings, update, save, loading, error } = useReleaseDraft(project)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const submit = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try { await save(); setNotice('平台绑定已保存，令牌使用系统加密存储') }
    catch (reason) { setNotice(reportClientFailure(reason)) }
    finally { setBusy(false) }
  }
  return <div className="release-platform-settings">
    <p className="settings-note">当前项目：{project.name}。项目绑定随项目保存，平台令牌在本机共用。</p>
    <fieldset className="release-edit-fields" disabled={loading || busy || Boolean(error)}><div className="release-form">
      <label className="release-platform-id">Modrinth 项目 ID<input value={settings.modrinthProjectId} onChange={event => update('modrinthProjectId', event.target.value)} /></label>
      <label className="release-platform-token">Modrinth Token<SecretInput aria-label="Modrinth Token" secretKey="modrinthToken" stored={Boolean(settings.hasModrinthToken)} value={settings.modrinthToken ?? ''} onChange={event => update('modrinthToken', event.target.value)} placeholder={settings.hasModrinthToken ? '已加密保存，留空保持不变' : ''} /></label>
      <label className="release-platform-id">CurseForge 项目 ID<input value={settings.curseForgeProjectId} onChange={event => update('curseForgeProjectId', event.target.value)} /></label>
      <label className="release-platform-token">CurseForge Token<SecretInput aria-label="CurseForge Token" secretKey="curseForgeToken" stored={Boolean(settings.hasCurseForgeToken)} value={settings.curseForgeToken ?? ''} onChange={event => update('curseForgeToken', event.target.value)} placeholder={settings.hasCurseForgeToken ? '已加密保存，留空保持不变' : ''} /></label>
      <label className="release-platform-id">GitHub 仓库<input value={settings.githubRepository} onChange={event => update('githubRepository', event.target.value)} placeholder="owner/repository" /></label>
      <label className="release-platform-token">GitHub Token<SecretInput aria-label="GitHub Token" secretKey="githubToken" stored={Boolean(settings.hasGithubToken)} value={settings.githubToken ?? ''} onChange={event => update('githubToken', event.target.value)} placeholder={settings.hasGithubToken ? '已加密保存，留空保持不变' : ''} /></label>
    </div><button className="primary-button" onClick={() => void submit()}>{loading || busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存平台配置</button></fieldset>
    {error || notice ? <div className="production-notice" role="status"><CircleAlert size={14} />{error || notice}</div> : null}
  </div>
}
