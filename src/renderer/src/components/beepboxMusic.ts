let frame: HTMLIFrameElement | null = null
let loading: Promise<HTMLIFrameElement> | null = null

function renderer(): Promise<HTMLIFrameElement> {
  if (frame?.isConnected && frame.contentWindow) return Promise.resolve(frame)
  if (!loading) loading = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const target = document.createElement('iframe')
    target.title = 'BeepBox 音频渲染'
    target.hidden = true
    target.src = new URL('./beepbox/render.html', document.baseURI).href
    const timeout = setTimeout(() => { cleanup(); target.remove(); reject(new Error('BeepBox 合成器加载超时')) }, 15000)
    const cleanup = (): void => { clearTimeout(timeout); window.removeEventListener('message', ready) }
    const ready = (event: MessageEvent): void => {
      if (event.source !== target.contentWindow || event.origin !== window.location.origin || event.data?.type !== 'modmind-beepbox:render-ready') return
      cleanup(); frame = target; resolve(target)
    }
    window.addEventListener('message', ready)
    document.body.append(target)
  }).catch(error => { loading = null; throw error })
  return loading
}

export async function renderBeepBoxSong(encoded: string, gain = 1): Promise<Uint8Array> {
  if (!encoded || encoded.length > 200000) throw new Error('BeepBox 音乐工程无效或过大')
  if (!Number.isFinite(gain) || gain < .01 || gain > 1) throw new Error('音乐总音量无效')
  const target = await renderer()
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timeout); window.removeEventListener('message', receive) }
    const receive = (event: MessageEvent): void => {
      if (event.source !== target.contentWindow || event.origin !== window.location.origin || event.data?.type !== 'modmind-beepbox:rendered' || event.data.id !== id) return
      cleanup()
      if (event.data.error) { reject(new Error(String(event.data.error))); return }
      if (!(event.data.bytes instanceof Uint8Array)) { reject(new Error('BeepBox 音频结果无效')); return }
      resolve(event.data.bytes)
    }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('BeepBox 音乐渲染超时')) }, 120000)
    window.addEventListener('message', receive)
    target.contentWindow?.postMessage({ type: 'modmind-beepbox:render', id, encoded, gain }, window.location.origin)
  })
}
