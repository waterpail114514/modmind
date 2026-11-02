import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InspirationChatMessage } from '../../../shared/types'
import { mokoInspirationScript, mokoModelCharacter } from '../../../shared/mokoInspiration'
import gptCharacter from '../assets/model-characters/gpt.webp'
import deepseekCharacter from '../assets/model-characters/deepseek.webp'
import './moko-inspiration.css'

export default function MokoInspirationIntro({ ready, error, model, messages, onMessages, onPrepared, onInputReady, onComplete, onRetry }: {
  ready: boolean
  error: string
  model: string
  messages: InspirationChatMessage[]
  onMessages: (updater: (messages: InspirationChatMessage[]) => InspirationChatMessage[]) => void
  onPrepared: () => void
  onInputReady: () => void
  onComplete: () => void
  onRetry: () => void
}): React.JSX.Element {
  const shield = useRef<HTMLDivElement>(null), actor = useRef<HTMLImageElement>(null)
  const latest = useRef({ messages, onMessages, onPrepared, onInputReady, onComplete })
  latest.current = { messages, onMessages, onPrepared, onInputReady, onComplete }
  const [round, setRound] = useState<number | null>(null)
  const [mode, setMode] = useState<'reading' | 'exiting' | 'input'>('reading')
  const [inputRect, setInputRect] = useState<{ top: number; left: number; right: number; bottom: number; width: number; height: number } | null>(null)
  const typing = useRef<{ line: InspirationChatMessage; letters: string[]; count: number }>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const advanceRef = useRef<() => void>(() => {})
  const summoned = round !== null && round >= mokoInspirationScript(model).length - 1
  const character = mokoModelCharacter(model)
  const write = (line: InspirationChatMessage, count: number, advanced = false): void => {
    const letters = Array.from(line.content)
    const next = { ...line, content: letters.slice(0, count).join(''), onboarding: { ...line.onboarding!, complete: count >= letters.length, advanced } }
    latest.current.onMessages(current => current.some(message => message.id === line.id)
      ? current.map(message => message.id === line.id ? next : message) : [...current, next])
  }
  const advance = (): void => {
    if (!ready || error || mode !== 'reading' || document.body.hasAttribute('data-loading-covered') || !typing.current) return
    const current = typing.current
    clearTimeout(timer.current)
    if (current.count < current.letters.length) {
      current.count = current.letters.length
      write(current.line, current.count)
      return
    }
    write(current.line, current.count, true)
    typing.current = undefined
    if (round === mokoInspirationScript(model).length - 1) setMode('exiting')
    else setRound(index => (index ?? -1) + 1)
  }
  advanceRef.current = advance
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const saved = new Map<HTMLElement, boolean>()
    const lock = (element: HTMLElement): void => { saved.set(element, element.inert); element.inert = true }
    const composer = document.querySelector<HTMLElement>('.inspiration-page:not([hidden]) .inspiration-composer')
    const allowed = mode === 'input' && composer ? Array.from(composer.querySelectorAll<HTMLElement>('textarea,.agent-send-button')) : []
    if (allowed.length) {
      // Inert cannot be overridden by descendants: lock siblings along the input path.
      const lockSiblings = (parent: HTMLElement): void => {
        for (const child of Array.from(parent.children)) {
          if (!(child instanceof HTMLElement) || child === shield.current || child.id === 'app-loading') continue
          if (allowed.includes(child)) continue
          if (allowed.some(element => child.contains(element))) lockSiblings(child)
          else lock(child)
        }
      }
      lockSiblings(document.body)
    } else document.querySelectorAll<HTMLElement>('.app-body,.titlebar').forEach(lock)
    document.body.setAttribute('data-moko-intro-locked', '')
    document.body.toggleAttribute('data-moko-intro-input', mode === 'input')
    if (mode === 'input') allowed[0]?.focus({ preventScroll: true })
    else shield.current?.focus({ preventScroll: true })
    const block = (event: KeyboardEvent): void => {
      if (event.target instanceof Node && error && shield.current?.contains(event.target) && ['Tab', 'Enter', ' '].includes(event.key)) return
      if (mode === 'input' && allowed.some(element => element === event.target)) {
        if (event.key === 'Tab') {
          event.preventDefault(); event.stopImmediatePropagation()
          const controls = allowed.filter(element => !(element as HTMLButtonElement).disabled)
          const index = controls.indexOf(document.activeElement as HTMLElement)
          controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus({ preventScroll: true })
          return
        }
        if (!(event.ctrlKey || event.metaKey) || ['a', 'c', 'v', 'x', 'z', 'y', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      }
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) advanceRef.current()
      event.preventDefault(); event.stopImmediatePropagation()
    }
    const blockWheel = (event: WheelEvent): void => {
      if (mode === 'input' && allowed[0] === event.target) return
      event.preventDefault(); event.stopImmediatePropagation()
    }
    const blockDrop = (event: DragEvent): void => { event.preventDefault(); event.stopImmediatePropagation() }
    window.addEventListener('keydown', block, true)
    window.addEventListener('wheel', blockWheel, { capture: true, passive: false })
    window.addEventListener('dragover', blockDrop, true)
    window.addEventListener('drop', blockDrop, true)
    return () => {
      window.removeEventListener('keydown', block, true)
      window.removeEventListener('wheel', blockWheel, true)
      window.removeEventListener('dragover', blockDrop, true)
      window.removeEventListener('drop', blockDrop, true)
      document.body.removeAttribute('data-moko-intro-locked')
      document.body.removeAttribute('data-moko-intro-input')
      saved.forEach((inert, element) => { element.inert = inert })
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [error, mode])
  useEffect(() => { if (ready || error) latest.current.onPrepared() }, [ready, error])
  useEffect(() => {
    if (!ready || error) return
    let started = false
    const start = (): void => {
      if (started || document.body.hasAttribute('data-loading-covered')) return
      started = true; observer.disconnect()
      if (latest.current.messages.some(message => message.role === 'user')) { latest.current.onComplete(); return }
      const script = mokoInspirationScript(model)
      let lastIndex = script.length - 1
      while (lastIndex >= 0 && !latest.current.messages.some(message => message.id === script[lastIndex].id)) lastIndex -= 1
      const saved = latest.current.messages.find(message => message.id === script[lastIndex]?.id)
      if (lastIndex === script.length - 1 && saved?.onboarding?.advanced) { setMode('input'); return }
      setRound(saved?.onboarding?.advanced ? lastIndex + 1 : Math.max(0, lastIndex))
    }
    const observer = new MutationObserver(start)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-loading-covered'] })
    start()
    return () => observer.disconnect()
  }, [ready, error, model])
  useEffect(() => {
    if (round === null || !ready || error || mode !== 'reading') return
    const line = mokoInspirationScript(model)[round]
    if (!line) return
    const letters = Array.from(line.content), saved = latest.current.messages.find(message => message.id === line.id)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const current = { line, letters, count: saved?.onboarding?.complete || reduced ? letters.length : Math.min(letters.length, Array.from(saved?.content ?? '').length) }
    typing.current = current
    const tick = (): void => {
      current.count = Math.min(letters.length, current.count + 2)
      write(line, current.count)
      if (current.count < letters.length) timer.current = setTimeout(tick, 32)
    }
    tick()
    return () => { clearTimeout(timer.current); typing.current = undefined }
  }, [round, ready, error, model, mode])
  useEffect(() => {
    if (mode !== 'exiting') return
    const timeout = setTimeout(() => setMode('input'), 240)
    return () => clearTimeout(timeout)
  }, [mode])
  useLayoutEffect(() => {
    if (mode !== 'input') return
    const composer = document.querySelector<HTMLElement>('.inspiration-page:not([hidden]) .inspiration-composer')
    if (!composer) return
    const measure = (): void => {
      const { top, left, right, bottom, width, height } = composer.getBoundingClientRect()
      setInputRect(previous => previous && previous.top === top && previous.left === left && previous.width === width && previous.height === height ? previous : { top, left, right, bottom, width, height })
    }
    measure(); latest.current.onInputReady()
    const observer = new ResizeObserver(measure)
    observer.observe(composer)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [mode])
  useLayoutEffect(() => {
    const element = actor.current
    if (!element || !summoned) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const easing = getComputedStyle(element).getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.23, 1, 0.32, 1)'
    const animation = element.animate(reduced ? [{ opacity: 0 }, { opacity: 0.14 }] : [
      { opacity: 0, transform: 'translateX(100%)' }, { opacity: 0.14, transform: 'translateX(0)' }
    ], { duration: 240, easing })
    return () => animation.cancel()
  }, [summoned])
  return createPortal(<div className="moko-inspiration-stage" ref={shield} tabIndex={-1} data-mode={mode} data-input-ready={Boolean(inputRect)} data-exiting={mode !== 'reading'} role="region" aria-label={mode === 'input' ? '在高亮的灵感输入框写下你的想法' : '茉可正在介绍灵感台和工作台'} onClick={advance}>
    {mode !== 'input' ? <><div className="moko-inspiration-portrait" aria-hidden="true" />
      {summoned && character !== 'other' ? <img ref={actor} className="moko-inspiration-ai" src={character === 'deepseek' ? deepseekCharacter : gptCharacter} alt="" draggable={false} /> : null}</> : null}
    {mode === 'input' && inputRect ? <div aria-hidden="true">
      <div className="moko-input-outline" style={{ top: inputRect.top, left: inputRect.left, width: inputRect.width, height: inputRect.height }} />
      <div className="moko-input-blocker" style={{ top: 0, left: 0, right: 0, height: Math.max(0, inputRect.top) }} />
      <div className="moko-input-blocker" style={{ top: inputRect.top, left: 0, width: Math.max(0, inputRect.left), height: inputRect.height }} />
      <div className="moko-input-blocker" style={{ top: inputRect.top, left: inputRect.right, right: 0, height: inputRect.height }} />
      <div className="moko-input-blocker" style={{ top: inputRect.bottom, left: 0, right: 0, bottom: 0 }} />
    </div> : null}
    {error ? <div className="moko-inspiration-recovery" role="alert"><p>{error}</p><button className="secondary-button" onClick={onRetry}>重新读取灵感对话</button></div> : null}
  </div>, document.body)
}

export function MokoInspirationMessage({ message, active = false }: { message: InspirationChatMessage; active?: boolean }): React.JSX.Element {
  const speaker = message.onboarding?.speaker === 'moko' ? '茉可' : '灵感台'
  return <div className="inspiration-message assistant moko-script-message" data-speaker={speaker}>
    <span aria-hidden="true">{speaker === '茉可' ? '茉' : 'AI'}</span>
    <div><strong>{speaker}</strong><p>{message.content}{!message.onboarding?.complete ? <span className="moko-script-cursor" aria-hidden="true">▍</span> : null}</p>{active && !message.onboarding?.advanced ? <span className="moko-script-hint">{message.onboarding?.complete ? '点击任意位置继续' : '点击任意位置显示全文'}</span> : null}</div>
  </div>
}
