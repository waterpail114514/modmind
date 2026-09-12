import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import type { ModMindApi } from '../../../shared/types'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  secretKey: Parameters<ModMindApi['settings']['revealSecret']>[0]
  stored: boolean
}

/** Saved secrets stay in encrypted storage until explicitly revealed. */
export function SecretInput({ secretKey, stored, value, onChange, ...props }: Props) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setRevealed(null)
    setVisible(false)
    setError('')
    setBusy(false)
    return () => { generation.current++ }
  }, [secretKey, stored, value])
  const masked = !value && stored && revealed === null
  const toggle = async (): Promise<void> => {
    if (visible) { setVisible(false); setRevealed(null); return }
    if (value) { setVisible(true); return }
    const request = generation.current
    setBusy(true)
    setError('')
    try {
      const secret = await window.modmind.settings.revealSecret(secretKey)
      if (request !== generation.current) return
      if (!secret) throw new Error('无法读取已保存凭证，请重新填写并保存')
      setRevealed(secret)
      setVisible(true)
    } catch (error) {
      if (request === generation.current) setError(error instanceof Error ? error.message : '读取失败')
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  return <span style={{ display: 'grid', gap: 6 }}>
    <span style={{ display: 'flex', gap: 8 }}>
      <input {...props} data-secret="true" type={visible ? 'text' : 'password'} autoComplete="off"
        style={{ minWidth: 0, flex: 1 }} value={value || revealed || (masked ? '••••••••' : '')}
        onFocus={(event) => { if (masked || revealed !== null) event.target.select(); props.onFocus?.(event) }}
        onChange={(event) => {
          if (masked) event.target.value = event.target.value.replaceAll('•', '')
          generation.current++
          setRevealed(null)
          setVisible(false)
          onChange?.(event)
        }} />
      <button className="secondary-button compact" type="button" disabled={busy || (!stored && !value)}
        aria-label={visible ? '隐藏凭证' : '显示凭证原文'} aria-pressed={visible} onClick={() => void toggle()}>
        {busy ? '读取中…' : visible ? '隐藏' : '显示'}
      </button>
    </span>
    {error ? <small role="alert">{error}</small> : null}
  </span>
}
