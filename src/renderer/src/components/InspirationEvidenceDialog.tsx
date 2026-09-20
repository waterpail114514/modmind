import { useEffect, useRef, useState } from 'react'
import { parseInspirationEvidenceLink, type InspirationEvidence } from '../../../shared/inspirationEvidence'

export default function InspirationEvidenceDialog({ projectPath, href, onClose }: { projectPath: string; href: string; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [evidence, setEvidence] = useState<InspirationEvidence>()
  const [error, setError] = useState('')
  const [line, setLine] = useState<number>()
  const [busy, setBusy] = useState(true)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  useEffect(() => {
    let active = true
    setBusy(true); setError('')
    void (async () => {
      try {
        const input = parseInspirationEvidenceLink(href)
        const result = await window.modmind.inspiration.readEvidence(projectPath, { ...input, line: line ?? input.line })
        if (active) setEvidence(result)
      } catch (error) { if (active) setError(error instanceof Error ? error.message : String(error)) }
      finally { if (active) setBusy(false) }
    })()
    return () => { active = false }
  }, [projectPath, href, line])
  return <dialog ref={dialog} className="inspiration-knowledge-dialog inspiration-evidence-dialog" aria-label="查看分析来源" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><strong>分析来源</strong><button type="button" onClick={onClose}>关闭</button></header>
    {busy ? <p role="status">正在读取…</p> : error ? <p role="alert">{error}</p> : evidence ? <>
      <p>{evidence.source}{evidence.file ? ` / ${evidence.file}` : ''}{evidence.sha256 ? ` · SHA256 ${evidence.sha256.slice(0, 12)}` : ''}</p>
      <pre>{evidence.lines.map(item => `${item.line}  ${item.text}`).join('\n')}</pre>
      <footer><span>共 {evidence.totalLines} 行</span>{evidence.nextStartLine ? <button type="button" onClick={() => setLine(evidence.nextStartLine)}>下一段</button> : null}</footer>
    </> : null}
  </dialog>
}
