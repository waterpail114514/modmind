import { useEffect, useState } from 'react'
import { Binary, ChevronRight, CircleAlert, LoaderCircle, PackageOpen, X } from 'lucide-react'
import { decompileTargetPlatforms, type DecompilePlatform, type DecompileInspectResult, type DecompileProgressEvent } from '../../src/shared/decompile'
import type { DecompileTermsPayload } from '../../src/shared/decompileModuleExport'
import type { ProjectInfo } from '../../src/shared/types'
import { platformLabel } from '../../src/shared/projectPlatform'
import { reportClientFailure as errorMessage } from '../../src/renderer/src/lib/clientFailure'
import type { FeaturePageContext } from '../sdk/renderer'

export default function AdoptJarLauncher(context: FeaturePageContext): React.JSX.Element {
  const [inspection, setInspection] = useState<DecompileInspectResult | null>(null)
  const [busy, setBusy] = useState(false)
  const inspect = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { const picked = await window.modmind.decompile.pickJar(); if (picked) setInspection(await window.modmind.decompile.inspect(picked)) } catch (error) { context.setNotice(errorMessage(error)) } finally { setBusy(false) }
  }
  return <><button className="project-launcher-action" type="button" disabled={busy} onClick={() => void inspect()}><span className="project-launcher-icon adopt">{busy ? <LoaderCircle className="spin" size={19} /> : <Binary size={19} />}</span><span><strong>接管模组或插件</strong><small>模组或服务端插件 JAR</small></span><ChevronRight size={17} /></button>{inspection ? <AdoptModJarDialog inspection={inspection} onClose={() => setInspection(null)} onAdopted={project => { setInspection(null); context.openProject(project) }} /> : null}</>
}

function AdoptModJarDialog({
  inspection,
  onClose,
  onAdopted
}: {
  inspection: DecompileInspectResult
  onClose: () => void
  onAdopted: (project: ProjectInfo) => void
}): React.JSX.Element {
  const [name, setName] = useState(inspection.displayName?.trim() || inspection.fileName.replace(/\.jar$/i, ''))
  const [loader, setLoader] = useState<DecompilePlatform>(inspection.loader ?? 'fabric')
  const [minecraftVersion, setMinecraftVersion] = useState(inspection.minecraftVersions[0] ?? '')
  const [stage, setStage] = useState<'confirm' | 'terms'>('confirm')
  const [terms, setTerms] = useState<DecompileTermsPayload | null>(null)
  const [sourceSha256, setSourceSha256] = useState(inspection.sha256)
  const [progress, setProgress] = useState<DecompileProgressEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sizeLabel = inspection.size < 1024 * 1024
    ? `${(inspection.size / 1024).toFixed(1)} KB`
    : `${(inspection.size / 1024 / 1024).toFixed(1)} MB`

  useEffect(() => window.modmind.decompile.onProgress(setProgress), [])

  const startDecompile = async (): Promise<void> => {
    if (!name.trim() || !minecraftVersion.trim()) return
    setBusy(true)
    setError('')
    setProgress({ jarSha256: inspection.sha256, phase: 'hashing', message: '正在准备反编译' })
    try {
      const result = await window.modmind.decompile.start({
        jarPath: inspection.filePath,
        minecraftVersion: minecraftVersion.trim()
      })
      setSourceSha256(result.sha256)
      setTerms(await window.modmind.decompile.getTerms(inspection.fileName))
      setStage('terms')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const adopt = async (): Promise<void> => {
    if (!terms) return
    setBusy(true)
    setError('')
    try {
      const project = await window.modmind.decompile.createProjectFromJar({
        sourceSha256,
        name,
        loader,
        minecraftVersion: minecraftVersion.trim(),
        termsAcknowledgement: { termsVersion: terms.version, acknowledged: true, origin: 'user-workspace' }
      })
      if (project) onAdopted(project)
      else setBusy(false)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  const reasons = [
    `已识别 ${platformLabel(loader)} ${inspection.plugin ? "插件" : "模组"}描述文件`,
    !inspection.plugin && inspection.minecraftVersions.length
      ? `已自动识别 Minecraft ${inspection.minecraftVersions.join(' / ')}`
      : inspection.plugin ? '请确认目标 Minecraft / 代理 API 版本' : '未能自动识别 Minecraft 版本，请手动确认',
    ...inspection.warnings
  ]

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div className="dialog adopt-dialog mod-jar-adopt-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2>接管模组或插件</h2><p>{inspection.filePath}</p></div>
          <button className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="adopt-detection">
          <span className="adopt-kind complete">{inspection.plugin ? "JAR 服务端插件" : "JAR 模组"}</span>
          <div><strong>{inspection.classCount} 个类</strong><small>{platformLabel(loader)} · {sizeLabel} · sha256 {inspection.sha256.slice(0, 12)}…</small></div>
        </div>
        {busy ? <div className="adapter-note"><LoaderCircle className="spin" size={16} /><p><strong>正在反编译</strong><span>{progress?.message ?? '正在准备受控反编译环境'}</span></p></div> : null}
        {stage === 'confirm' ? <>
          <div className="adopt-reasons">{reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
          <div className="adopt-fields">
            <label className="field-label">项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="field-label">{loader === 'velocity' ? '代理 API 版本' : 'Minecraft 版本'}
              <input list={`decompile-versions-${inspection.sha256.slice(0, 8)}`} value={minecraftVersion} onChange={(event) => setMinecraftVersion(event.target.value)} placeholder={loader === 'velocity' ? '例如：3.4.0-SNAPSHOT' : '例如：1.21.1'} />
              <datalist id={`decompile-versions-${inspection.sha256.slice(0, 8)}`}>{inspection.minecraftVersions.map((version) => <option key={version} value={version} />)}</datalist>
            </label>
            <label className="field-label">{inspection.plugin ? '插件平台' : '加载器'}<select value={loader} onChange={(event) => setLoader(event.target.value as DecompilePlatform)}>{decompileTargetPlatforms(inspection.plugin).map(platform => <option key={platform} value={platform}>{platformLabel(platform)}</option>)}</select></label>
          </div>
          <div className="adopt-files"><span>检测到的 JAR 文件</span><code>{inspection.fileName}</code></div>
        </> : terms ? <>
          <div className="decompile-terms-body">
            {terms.sections.map((section) => <section key={section.heading}><h4>{section.heading}</h4>{section.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}
            <p className="decompile-terms-source">来源 JAR：{inspection.fileName}（sha256: {sourceSha256.slice(0, 16)}…）。接受记录会写入生成的项目目录。</p>
          </div>
        </> : null}
        {error ? <div className="inline-error"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={stage === 'terms' ? () => setStage('confirm') : onClose}>{stage === 'terms' ? '返回' : '取消'}</button>
          {stage === 'confirm' ? <button className="primary-button" disabled={busy || !name.trim() || !minecraftVersion.trim()} onClick={() => void startDecompile()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Binary size={16} />}反编译并接管
          </button> : <button className="primary-button decompile-danger-confirm" disabled={busy || !terms} onClick={() => void adopt()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <PackageOpen size={16} />}我已阅读并同意，创建项目
          </button>}
        </div>
      </div>
    </div>
  )
}
