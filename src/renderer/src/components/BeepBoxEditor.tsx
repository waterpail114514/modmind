import { useEffect, useRef } from 'react'

export default function BeepBoxEditor({ song, view, onChange }: { song: string; view: 'notes' | 'tracks' | 'settings'; onChange: (song: string, hasNotes: boolean) => void }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const initialSong = useRef(song)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    const sendTheme = (): void => {
      const styles = getComputedStyle(document.querySelector('.app-shell') ?? document.documentElement)
      const value = (name: string): string => styles.getPropertyValue('--theme-' + name).trim()
      frame.current?.contentWindow?.postMessage({
        type: 'modmind-beepbox:theme', dark: document.documentElement.getAttribute('data-theme-mode') === 'dark',
        palette: { canvas: value('canvas'), panel: value('panel'), surface: value('surface'), raised: value('raised'), text: value('text'), muted: value('muted'), line: value('line'), accent: value('accent'), selected: value('selected'), action: value('action'), onAction: value('on-action') }
      }, window.location.origin)
    }
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return
      if (event.data.type === 'modmind-beepbox:ready') {
        sendTheme()
        frame.current?.contentWindow?.postMessage({ type: 'modmind-beepbox:view', view: viewRef.current }, window.location.origin)
      }
      if (['modmind-beepbox:ready', 'modmind-beepbox:changed'].includes(event.data.type) && typeof event.data.song === 'string' && event.data.song.length <= 200000) onChangeRef.current(event.data.song, event.data.hasNotes === true)
    }
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode', 'style'] })
    window.addEventListener('message', receive)
    return () => { observer.disconnect(); window.removeEventListener('message', receive) }
  }, [])
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'modmind-beepbox:view', view }, window.location.origin) }, [view])
  return <iframe ref={frame} className="sound-beepbox-frame" title="BeepBox 音乐编辑器" src={new URL('./beepbox/index.html', document.baseURI).href + (initialSong.current ? '#' + initialSong.current : '')} />
}
