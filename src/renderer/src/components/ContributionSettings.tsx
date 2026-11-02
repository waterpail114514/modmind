import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { CONTRIBUTION_CONFIRM_MS, CONTRIBUTION_TERMS, CONTRIBUTION_TERMS_VERSION,
  type ContributionChallenge, type ContributionPreview, type ContributionState } from '../../../shared/contributions'
import './contribution-settings.css'

export default function ContributionSettings(): React.JSX.Element {
  const [state, setState] = useState<ContributionState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'consent' | 'terms' | 'preview' | null>(null)
  const [challenge, setChallenge] = useState<ContributionChallenge | null>(null)
  const [seconds, setSeconds] = useState(3)
  const [preview, setPreview] = useState<ContributionPreview | null>(null)
  const action = useRef(false)
  const mounted = useRef(true)
  const refresh = async (): Promise<void> => {
    try { const value = await window.modmind.contributions.getState(); if (mounted.current) setState(value) }
    catch { if (mounted.current) setError('贡献设置暂时无法读取，请重试。') }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (!action.current) void refresh() }, 10_000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (dialog !== 'consent' || !challenge) return
    const until = performance.now() + CONTRIBUTION_CONFIRM_MS
    setSeconds(3)
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.ceil((until - performance.now()) / 1000))), 100)
    return () => window.clearInterval(timer)
  }, [dialog, challenge])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (action.current) return
    action.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成，请重试。') }
    finally { action.current = false; setBusy(false) }
  }
  const toggle = (): void => { void run(async () => {
    if (state?.enabled) setState(await window.modmind.contributions.disable())
    else {
      await refresh()
      setSeconds(3)
      setChallenge(await window.modmind.contributions.beginConsent())
      setDialog('consent')
    }
  }) }
  const close = (): void => { if (!busy) { setDialog(null); setChallenge(null); setError('') } }
  const status = !state ? '正在读取…' : state.enabled
    ? state.message || (state.phase === 'uploading' ? '正在上传贡献统计…' : state.pendingReports ? `待上传 ${state.pendingReports} 份统计` : '已开启，后续统计将自动上传')
    : '已关闭'
  return <>
    <div className="settings-heading"><h2>帮助改进 ModMind</h2></div>
    <div className="contribution-setting-row">
      <div className="contribution-toggle"><span>自动贡献使用统计</span><button className={`toggle ${state?.enabled ? 'on' : ''}`} type="button" role="switch" aria-label="自动贡献使用统计" aria-checked={state?.enabled ?? false} disabled={!state || busy} onClick={toggle}><span /></button></div>
      <div className="settings-button-group">
        <button className="secondary-button compact" type="button" disabled={busy} onClick={() => { setError(''); setDialog('terms') }}>使用条例</button>
        <button className="secondary-button compact" type="button" disabled={!state || busy} onClick={() => void run(async () => { setPreview(await window.modmind.contributions.preview()); setDialog('preview') })}>查看待传内容</button>
      </div>
    </div>
    <p className="contribution-status" role="status">{status}{state?.lastUploadedAt ? ` · 上次上传 ${new Date(state.lastUploadedAt).toLocaleString()}` : ''}</p>
    {error && !dialog && <p className="contribution-error" role="alert">{error}<button className="secondary-button compact" type="button" onClick={() => void refresh()}>重试读取</button></p>}
    <Dialog.Root open={dialog !== null} onOpenChange={open => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="contribution-overlay" />
        <Dialog.Content className="contribution-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
          <div className="contribution-dialog-header">
            <Dialog.Title>{dialog === 'preview' ? '待传贡献内容' : '数据贡献使用条例'}</Dialog.Title>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭贡献弹窗" disabled={busy}><X size={18} /></button></Dialog.Close>
          </div>
          <Dialog.Description className="contribution-description">{dialog === 'preview' ? '以下为当前目录最多三份待传统计，关闭贡献会清空本地待传队列。' : '请阅读收集范围、目录命名与关闭方式，再决定是否参加。'}</Dialog.Description>
          <p className="contribution-directory">贡献目录：<code>{dialog === 'preview' ? preview?.folder : challenge?.folder ?? state?.folder ?? '读取后显示'}</code></p>
          <div className="contribution-dialog-body" tabIndex={0}>
            {dialog === 'preview' ? <>
              {preview?.reports.length ? <pre>{JSON.stringify(preview.reports, null, 2)}</pre> : <p>当前目录没有待传统计。</p>}
              {preview?.truncated && <p>还有其他待传统计未在此展开。</p>}
            </> : <>
              <ol>{CONTRIBUTION_TERMS.map(term => <li key={term}>{term}</li>)}</ol>
              <p className="contribution-terms-version">条例版本 {CONTRIBUTION_TERMS_VERSION}</p>
            </>}
          </div>
          {error && <p className="contribution-error contribution-dialog-error" role="alert">{error}</p>}
          <div className="contribution-dialog-footer">
            <button className="secondary-button" type="button" disabled={busy} onClick={close}>{dialog === 'consent' ? '暂不参加' : '关闭'}</button>
            {dialog === 'consent' && <button className="primary-button contribution-confirm" type="button" disabled={busy || seconds > 0 || !challenge} onClick={() => void run(async () => {
              if (!challenge || seconds > 0) return
              setState(await window.modmind.contributions.enable(challenge.token, challenge.termsVersion))
              setDialog(null); setChallenge(null)
            })}>{busy ? '正在开启…' : seconds > 0 ? `同意并开启（${seconds}秒）` : '同意并开启'}</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}
