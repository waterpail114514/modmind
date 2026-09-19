(() => {
  'use strict'

  const CHANNEL = 'modmind-minipaint'

  function reply(type, payload = {}) {
    window.parent.postMessage({ channel: CHANNEL, type, ...payload }, '*')
  }

  function applyTheme(theme, palette, scrollbarStyle) {
    const normalized = theme === 'dark' ? 'dark' : 'light'
    document.body.classList.toggle('theme-light', normalized === 'light')
    document.body.classList.toggle('theme-dark', normalized === 'dark')
    document.documentElement.style.colorScheme = normalized
    for (const [name, value] of Object.entries(palette || {})) document.body.style.setProperty(name, value)
    let focusStyle = document.getElementById('modmind-theme-controls')
    if (!focusStyle) {
      focusStyle = document.createElement('style')
      focusStyle.id = 'modmind-theme-controls'
      focusStyle.textContent = 'input { accent-color: var(--link-color); } button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; box-shadow: inset 0 -1px 0 var(--input-border-color-active); }'
      document.head.appendChild(focusStyle)
    }
    if (typeof scrollbarStyle === 'string') {
      let scrollbars = document.getElementById('modmind-scrollbars')
      if (!scrollbars) { scrollbars = document.createElement('style'); scrollbars.id = 'modmind-scrollbars'; document.head.appendChild(scrollbars) }
      scrollbars.textContent = scrollbarStyle
    }
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片无法解码'))
      image.src = dataUrl
    })
  }

  async function openImage(dataUrl, name) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 30 * 1024 * 1024) throw new Error('图片数据无效或过大')
    if (!/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('只支持 PNG、JPEG、WebP、GIF 或 BMP 图片')
    if (!globalThis.FileOpen || !globalThis.Layers || !globalThis.AppConfig) throw new Error('miniPaint 文件接口尚未准备好')
    const image = await loadImage(dataUrl)
    await globalThis.Layers.reset_layers(false)
    globalThis.FileOpen.file_open_data_url_handler(dataUrl)
    await new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const check = () => {
        const layer = globalThis.AppConfig.layer
        if (globalThis.AppConfig.WIDTH === image.naturalWidth && globalThis.AppConfig.HEIGHT === image.naturalHeight && layer && layer.type === 'image') {
          if (typeof name === 'string' && name) layer.name = name.slice(0, 120)
          globalThis.Layers.refresh_gui()
          globalThis.Layers.Base_gui?.GUI_information?.show_size(true)
          globalThis.AppConfig.need_render = true
          resolve()
          return
        }
        if (Date.now() - startedAt > 10_000) { reject(new Error('miniPaint 打开图片超时')); return }
        requestAnimationFrame(check)
      }
      check()
    })
  }

  function exportPng() {
    if (!globalThis.Layers || !globalThis.AppConfig || !globalThis.AppConfig.WIDTH || !globalThis.AppConfig.HEIGHT) throw new Error('编辑器当前没有可导出的画布')
    const canvas = document.createElement('canvas')
    canvas.width = globalThis.AppConfig.WIDTH
    canvas.height = globalThis.AppConfig.HEIGHT
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建导出画布')
    context.imageSmoothingEnabled = false
    globalThis.Layers.convert_layers_to_canvas(context, null, false)
    return canvas.toDataURL('image/png')
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || !event.data || event.data.channel !== CHANNEL) return
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
    try {
      if (event.data.type === 'theme') applyTheme(event.data.theme, event.data.palette, event.data.scrollbarStyle)
      else if (event.data.type === 'open') { await openImage(event.data.dataUrl, event.data.name); reply('openResult', { requestId }) }
      else if (event.data.type === 'export') reply('exportResult', { requestId, dataUrl: exportPng() })
    } catch (error) {
      reply('error', { requestId, message: error instanceof Error ? error.message : String(error) })
    }
  })

  window.addEventListener('load', () => {
    applyTheme('light')
    reply('ready')
  })
})()
