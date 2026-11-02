import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2 } from 'lucide-react'
import './audio-player.css'

export default function AudioPlayer({ src, className = '' }: { src: string; className?: string }): React.JSX.Element {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const sourceId = useRef('')
  const record = (operation: string): void => {
    const element = audio.current
    try { window.modmind?.diagnostics?.reportEvent?.({ operation: `audio-${operation}`, data: { sourceId: sourceId.current, currentTime: element?.currentTime, duration: Number.isFinite(element?.duration) ? element?.duration : undefined, paused: element?.paused, volume: element?.volume, readyState: element?.readyState, mediaError: element?.error?.code, mediaErrorMessage: element?.error?.message } }) } catch { /* Playback does not depend on diagnostic transport. */ }
  }

  useEffect(() => {
    const element = audio.current
    if (!element) return
    sourceId.current = crypto.randomUUID()
    setPlaying(false); setProgress(0); setDuration(0)
    record('source')
    const onLoaded = () => setDuration(Number.isFinite(element.duration) ? element.duration : 0)
    let lastSample = 0
    const onTime = () => { setProgress(element.currentTime); if (Date.now() - lastSample > 5000) { lastSample = Date.now(); record('progress') } }
    const onEnded = () => { record('ended'); setPlaying(false); setProgress(0) }
    const onError = () => record('error')
    const onPause = () => { setPlaying(false); record('paused') }
    element.addEventListener('error', onError)
    element.addEventListener('pause', onPause)
    element.addEventListener('loadedmetadata', onLoaded)
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('ended', onEnded)
    element.load()
    return () => { record('unload'); element.pause(); element.removeEventListener('error', onError); element.removeEventListener('pause', onPause); element.removeEventListener('loadedmetadata', onLoaded); element.removeEventListener('timeupdate', onTime); element.removeEventListener('ended', onEnded) }
  }, [src])

  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (element.paused) { const requestedSource = sourceId.current; record('play-request'); void element.play().then(() => { if (requestedSource !== sourceId.current) return; setPlaying(true); record('playing') }).catch(error => { if (requestedSource !== sourceId.current) return; setPlaying(false); record('play-failed'); window.modmind?.diagnostics?.reportError?.({ name: 'MediaError', message: String(error) }, 'audio-play') }) }
    else { record('pause-request'); element.pause(); setPlaying(false) }
  }
  const format = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
  return <div className={`modmind-audio-player ${className}`.trim()}>
    <audio ref={audio} src={src} preload="metadata" />
    <button type="button" className="icon-button" onClick={toggle} aria-label={playing ? '暂停试听' : '播放试听'} title={playing ? '暂停试听' : '播放试听'}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
    <span className="modmind-audio-time">{format(progress)}</span>
    <input className="modmind-audio-progress" type="range" min={0} max={duration || 1} step={0.01} value={Math.min(progress, duration || 1)} aria-label="播放进度" onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setProgress(value); record('seek') }} />
    <span className="modmind-audio-time">{format(duration)}</span>
    <Volume2 size={14} aria-hidden="true" />
    <input className="modmind-audio-volume" type="range" min={0} max={1} step={0.05} value={volume} aria-label="音量" onChange={event => { const value = Number(event.target.value); setVolume(value); if (audio.current) audio.current.volume = value; record('volume') }} />
  </div>
}
