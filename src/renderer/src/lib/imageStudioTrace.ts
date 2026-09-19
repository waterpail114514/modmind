import type { ModMindApi } from '../../../shared/types'

const enabled = import.meta.env?.DEV === true && import.meta.env?.VITE_IMAGE_TRACE === '1'
const endpoint = import.meta.env?.VITE_IMAGE_LOG_ENDPOINT || 'http://127.0.0.1:43187'
const clientId = crypto.randomUUID()
let sequence = 0
let runId: string | undefined
let nodeId: string | undefined
let status = 'connecting'
let directory = ''
let recorderSession = ''
let sending = false
let lastSnapshot = ''
let previousApi: ModMindApi['imageStudio'] | undefined
let wrappedApi: ModMindApi['imageStudio'] | undefined
const queue: Array<{ eventId: string; clientId: string; sequence: number; time: string; type: string; runId?: string; data: unknown }> = []
const images = new Map<string, string>()

function setStatus(value: string): void {
  status = value
  document.documentElement.dataset.imageRecording = value
  document.querySelectorAll<HTMLElement>('[data-image-recording-status]').forEach(element => {
    element.textContent = value === 'recording' ? '操作日志记录中' : value === 'flushing' ? `操作日志写入中（${queue.length}）` : '操作日志等待连接'
    element.title = value === 'recording' ? directory : '日志暂存在当前窗口，连接记录器后补写。请勿关闭窗口。'
  })
}

function enqueue(type: string, data: unknown): void {
  const number = ++sequence
  queue.push({ eventId: `${clientId}:${number}`, clientId, sequence: number, time: new Date().toISOString(), type, runId, data })
}

// Send each image once. Snapshots remain small even while dragging a large graph.
function normalize(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (/api[-_]?key|authorization|cookie|password|secret|token/i.test(key)) return '[REDACTED]'
  if (typeof value === 'function') return undefined
  if (typeof value === 'string' && value.startsWith('data:image/')) {
    let imageId = images.get(value)
    if (!imageId) {
      imageId = crypto.randomUUID()
      if (images.size >= 128) images.delete(images.keys().next().value!)
      images.set(value, imageId)
      enqueue('image.register', { imageId, dataUrl: value })
    }
    return { imageId }
  }
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    const result = Array.isArray(value) ? value.map(item => normalize(item, '', seen))
      : Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function').map(([name, item]) => [name, normalize(item, name, seen)]))
    seen.delete(value)
    return result
  }
  return value
}

async function drain(): Promise<void> {
  if (sending || !queue.length) return
  sending = true
  try {
    while (queue.length) {
      const response = await fetch(`${endpoint}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queue[0]), signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Recording HTTP ${response.status}`)
      queue.shift()
      setStatus(queue.length ? 'flushing' : 'recording')
    }
  } catch { setStatus('waiting') }
  finally { sending = false }
}

export function traceImageStudio(type: string, data: unknown = {}): void {
  if (!enabled) return
  if (type === 'workflow.run.start') runId = (data as { runId: string }).runId
  if (type === 'workflow.node.start') nodeId = (data as { nodeId: string }).nodeId
  enqueue(type, normalize(data))
  if (type === 'workflow.run.end') { runId = undefined; nodeId = undefined }
  void drain()
}

/** Includes both inspector selection and ReactFlow selection to diagnose accidental deletion. */
export function traceImageStudioSnapshot(data: unknown): void {
  if (!enabled) return
  const snapshot = normalize(data)
  const serialized = JSON.stringify(snapshot)
  if (serialized === lastSnapshot) return
  lastSnapshot = serialized
  enqueue('workspace.snapshot', snapshot)
  void drain()
}

export function tracedImageStudio(): ModMindApi['imageStudio'] {
  const api = window.modmind.imageStudio
  if (!enabled) return api
  if (api === previousApi && wrappedApi) return wrappedApi
  previousApi = api
  wrappedApi = Object.fromEntries(Object.entries(api).map(([operation, call]) => [operation, async (...args: unknown[]) => {
    const requestId = crypto.randomUUID()
    const started = performance.now()
    traceImageStudio('api.start', { requestId, operation, nodeId, args })
    try {
      const result = await (call as (...args: unknown[]) => Promise<unknown>)(...args)
      traceImageStudio('api.success', { requestId, operation, durationMs: Math.round(performance.now() - started), result })
      return result
    } catch (error) {
      traceImageStudio('api.error', { requestId, operation, durationMs: Math.round(performance.now() - started), error })
      throw error
    }
  }])) as ModMindApi['imageStudio']
  return wrappedApi
}

if (enabled) {
  const cleanups: Array<() => void> = []
  const instrument = (doc: Document, editor = false): void => {
    const capture = (event: Event): void => {
      const target = event.target as HTMLElement | null
      if (!target?.closest || (!editor && !target.closest('.image-studio-page'))) return
      const control = target.closest<HTMLElement>('button,input,textarea,select,a,summary,[role="button"],.react-flow__node,.react-flow__edge') || target
      const field = control as HTMLInputElement
      const keyboard = event as KeyboardEvent
      // Text is captured by input/change; shortcuts retain modifier and repeat state.
      if (event.type === 'keydown' && !['Delete', 'Backspace', 'Enter', 'Escape', 'Tab'].includes(keyboard.key) && !keyboard.ctrlKey && !keyboard.metaKey) return
      const pointer = event as PointerEvent
      if (event.type === 'pointermove' && (!editor || !pointer.buttons)) return
      traceImageStudio(editor ? 'editor.interaction' : 'ui.interaction', {
        event: event.type, tag: control.tagName, id: control.id, nodeId: control.closest('[data-id]')?.getAttribute('data-id'),
        label: control.getAttribute('aria-label') || control.title || control.closest('label')?.textContent?.slice(0, 160) || control.textContent?.slice(0, 160),
        value: field.type === 'password' ? '[REDACTED]' : field.value,
        checked: field.type === 'checkbox' ? field.checked : undefined,
        files: field.files ? [...field.files].map(file => ({ name: file.name, size: file.size, type: file.type })) : undefined,
        key: event.type === 'keydown' ? keyboard.key : undefined, ctrl: keyboard.ctrlKey, shift: keyboard.shiftKey, meta: keyboard.metaKey, repeat: keyboard.repeat,
        x: pointer.clientX, y: pointer.clientY, button: pointer.button,
        pressure: pointer.pressure, buttons: pointer.buttons,
        deltaX: (event as WheelEvent).deltaX, deltaY: (event as WheelEvent).deltaY,
        selectedNodes: [...doc.querySelectorAll('.react-flow__node.selected')].map(node => node.getAttribute('data-id')),
        selectedEdges: [...doc.querySelectorAll('.react-flow__edge.selected')].map(edge => edge.getAttribute('data-id'))
      })
    }
    for (const name of ['click', 'dblclick', 'contextmenu', 'input', 'change', 'keydown', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'drop']) {
      doc.addEventListener(name, capture, true)
      cleanups.push(() => doc.removeEventListener(name, capture, true))
    }
  }
  instrument(document)
  const attached = new WeakSet<Document>()
  const refresh = (): void => {
    setStatus(status)
    document.querySelectorAll<HTMLIFrameElement>('.image-studio-page iframe').forEach(frame => {
      try {
        const doc = frame.contentDocument
        if (doc && !attached.has(doc)) { attached.add(doc); instrument(doc, true); traceImageStudio('editor.attached') }
      } catch { /* Only same-origin editor documents are instrumented. */ }
    })
  }
  const timer = setInterval(() => { refresh(); void drain() }, 1000)
  const checkRecorder = async (): Promise<void> => {
    try {
      const response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(3000) })
      const result = await response.json()
      directory = result.directory
      if (recorderSession && recorderSession !== result.sessionId) {
        // A recorder restart must not leave the new session with dangling image references.
        for (const [dataUrl, imageId] of images) enqueue('image.register', { imageId, dataUrl })
        if (lastSnapshot) enqueue('workspace.snapshot', JSON.parse(lastSnapshot))
        enqueue('client.recorder-reconnected', { previousSession: recorderSession })
        void drain()
      }
      recorderSession = result.sessionId
    } catch { setStatus('waiting') }
  }
  const healthTimer = setInterval(() => void checkRecorder(), 5000)
  const onError = (event: ErrorEvent): void => traceImageStudio('window.error', { message: event.message, error: event.error })
  const onRejection = (event: PromiseRejectionEvent): void => traceImageStudio('window.rejection', { error: event.reason })
  const onMessage = (event: MessageEvent): void => {
    if (event.data?.channel !== 'modmind-minipaint') return
    if ([...document.querySelectorAll<HTMLIFrameElement>('.image-studio-page iframe')].some(frame => frame.contentWindow === event.source)) traceImageStudio('editor.message', event.data)
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('message', onMessage)
  void checkRecorder()
  traceImageStudio('client.attached', { url: location.href, clientId })
  import.meta.hot?.dispose(() => {
    traceImageStudio('client.hmr-dispose')
    clearInterval(timer)
    clearInterval(healthTimer)
    cleanups.forEach(cleanup => cleanup())
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('message', onMessage)
  })
}
