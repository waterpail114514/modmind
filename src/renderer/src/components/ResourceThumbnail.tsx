import { useEffect, useRef, useState } from 'react'
import { Image } from 'lucide-react'

export default function ResourceThumbnail({ projectPath, id, file, revision }: { projectPath: string; id: string; file: string; revision: number }): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    setUrl('')
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void window.modmind.resourcePacks.thumbnail(projectPath, id, file).then(value => { if (active) setUrl(value) }).catch(() => undefined)
    }, { root: host.current?.closest('.resource-pack-files'), rootMargin: '80px' })
    observer.observe(host.current!)
    return () => { active = false; observer.disconnect() }
  }, [projectPath, id, file, revision])
  return <span className="resource-file-thumbnail" ref={host}>{url ? <img src={url} alt="" /> : <Image size={14} />}</span>
}
