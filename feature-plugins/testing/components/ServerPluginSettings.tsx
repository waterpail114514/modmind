import { reportClientFailure } from "../../../src/renderer/src/lib/clientFailure"
import { useEffect, useState } from 'react'
import { FileCode2, LoaderCircle, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import type { ProjectInfo } from "../../../src/shared/types"
import type { ServerCore, ServerCoreBuild, ServerProfile } from "../../../src/shared/serverPlugin"

export function ServerPluginSettings({ project, disabled }: { project: ProjectInfo; disabled: boolean }): React.JSX.Element {
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [builds, setBuilds] = useState<ServerCoreBuild[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { let active = true; void window.modmind.serverPlugin.profile(project.path).then(value => { if (active) setProfile(value) }).catch(error => { if (active) setNotice(reportClientFailure(error)) }); return () => { active = false } }, [project.path])
  const patch = (value: Partial<ServerProfile>): void => { setProfile(previous => previous ? { ...previous, ...value } : null); setNotice('存在未保存的设置') }
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setNotice(''); try { await action() } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) } }
  return <section className="modpack-tool-section server-plugin-settings"><div className="modpack-tool-heading"><div><span className="plugin-card-kicker">CONFIGURATION</span><h2>服务端核心与运行配置</h2></div></div>{profile ? <><fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="modpack-form-grid">
    <label>核心<select value={profile.core} onChange={event => { patch({ core: event.target.value as ServerCore, build: undefined, localJar: undefined }); setBuilds([]) }}>{(project.loader === 'velocity' ? ['velocity', 'custom'] : ['paper', 'purpur', 'spigot', 'folia', 'custom']).map(core => <option key={core} value={core}>{core}</option>)}</select></label>
    <label>运行版本<input value={profile.version} onChange={event => { patch({ version: event.target.value, build: undefined }); setBuilds([]) }} /></label>
    <label>构建<select value={profile.build ?? ''} onChange={event => patch({ build: event.target.value || undefined })}><option value="">首次运行锁定稳定构建</option>{profile.build && !builds.some(item => item.build === profile.build) ? <option value={profile.build}>{profile.build}</option> : null}{builds.map(item => <option key={item.build} value={item.build}>{item.build} · {item.channel}</option>)}</select></label>
    <label>Java<select value={profile.javaVersion} onChange={event => patch({ javaVersion: Number(event.target.value) })}>{[8, 17, 21, 25].map(version => <option key={version}>{version}</option>)}</select></label>
    <label>内存 MB<input type="number" min={512} max={32768} step={512} value={profile.memoryMb} onChange={event => patch({ memoryMb: Number(event.target.value) })} /></label>
    <label>端口<input type="number" min={1024} max={65535} value={profile.port} onChange={event => patch({ port: Number(event.target.value) })} /></label>
  </div>
  <div className="modpack-tool-actions"><button className="secondary-button" onClick={() => void run(async () => { setBuilds(await window.modmind.serverPlugin.builds(profile.core, profile.version)); setNotice('构建目录已更新') })}><RefreshCw size={15} />刷新构建</button><button className="secondary-button" onClick={() => void run(async () => { const next = await window.modmind.serverPlugin.importCore(project.path); if (next) { setProfile(next); setNotice('本地核心已导入，兼容性待运行验证') } })}><Upload size={15} />导入核心 JAR</button><button className="primary-button" onClick={() => void run(async () => { setProfile(await window.modmind.serverPlugin.saveProfile(project.path, profile)); setNotice('运行设置已保存') })}><Save size={15} />保存</button></div></fieldset>{profile.localJar ? <p className="modpack-inline-note">{profile.localJar}</p> : null}</> : <LoaderCircle className="spin" size={18} />}{notice ? <p role="status" className="modpack-inline-note">{notice}</p> : null}</section>
}
