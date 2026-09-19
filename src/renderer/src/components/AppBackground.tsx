import { useEffect, useRef, useState } from 'react'
import { normalizeBackground } from '../../../shared/appTheme'
import { setBackgroundReady, useAppAppearance } from '../theme'

export function backgroundMediaUrl(file: string): string { return `modmind-media://background/${file}` }

export default function AppBackground(): React.JSX.Element | null {
  const appearance = useAppAppearance()
  const background = normalizeBackground(appearance.background)
  const video = useRef<HTMLVideoElement>(null)
  const [failedFile, setFailedFile] = useState('')
  const [loadedFile, setLoadedFile] = useState('')
  const file = background.media?.file
  useEffect(() => {
    setBackgroundReady(Boolean(file && file === loadedFile && file !== failedFile))
    return () => setBackgroundReady(false)
  }, [file, loadedFile, failedFile])
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      if (!video.current) return
      if (background.paused || document.hidden || reduced.matches) video.current.pause()
      else void video.current.play().catch(() => undefined)
    }
    update()
    document.addEventListener('visibilitychange', update)
    reduced.addEventListener('change', update)
    return () => { document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update) }
  }, [file, background.paused, loadedFile])
  if (!file) return null
  const style = { opacity: background.opacity, filter: `blur(${background.blur}px)`, objectFit: background.fit, transform: background.blur ? 'scale(1.06)' : undefined }
  return <div className="app-background" aria-hidden="true">
    {file !== failedFile && (background.media?.kind === 'video'
      ? <video key={file} ref={video} src={backgroundMediaUrl(file)} style={style} muted loop playsInline preload="auto" onLoadedData={() => setLoadedFile(file)} onError={() => setFailedFile(file)} />
      : <img key={file} src={backgroundMediaUrl(file)} style={style} alt="" onLoad={() => setLoadedFile(file)} onError={() => setFailedFile(file)} />)}
  </div>
}
