if (!window.localStorage.getItem('modmind-beepbox-initialized')) {
  window.localStorage.setItem('layout', 'tall')
  window.localStorage.setItem('showLetters', 'true')
  window.localStorage.setItem('modmind-beepbox-initialized', 'true')
}
window.localStorage.setItem('showScrollBar', 'true')
if (!window.location.hash) {
  const starter = new beepbox.Song()
  const data = starter.toJsonObject()
  data.introBars = 0
  data.loopBars = 4
  for (const channel of data.channels) channel.sequence = channel.sequence.slice(0, 4)
  starter.fromJsonObject(data)
  window.location.hash = starter.toBase64String()
}
const editor = new beepbox.SongEditor(document.getElementById('beepboxEditorContainer'))
const barScroll = document.createElement('input')
barScroll.type = 'range'
barScroll.className = 'modmind-bar-scroll'
barScroll.min = '0'
barScroll.step = '1'
barScroll.setAttribute('aria-label', '小节位置')
document.querySelector('.beepboxEditor .track-area')?.appendChild(barScroll)
barScroll.addEventListener('input', () => {
  editor.doc.barScrollPos = Number(barScroll.value)
  editor.doc.notifier.changed()
})
const updateTrackNavigation = () => {
  const last = Math.max(0, editor.doc.song.barCount - editor.doc.trackVisibleBars)
  document.documentElement.dataset.trackScrollable = String(last > 0)
  barScroll.hidden = last === 0
  barScroll.max = String(last)
  barScroll.value = String(Math.min(last, editor.doc.barScrollPos))
  barScroll.title = `第 ${Number(barScroll.value) + 1} 小节起，共 ${editor.doc.song.barCount} 小节`
}
document.querySelector('.beepboxEditor .pattern-area')?.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  const channel = editor.doc.channel
  if (editor.doc.song.getChannelIsNoise(channel)) return
  const current = editor.doc.song.channels[channel].octave
  const visible = editor.doc.getVisibleOctaveCount()
  const base = editor.doc.getBaseVisibleOctave(channel)
  const nextBase = Math.max(0, Math.min(beepbox.Config.pitchOctaves - visible, base - Math.sign(event.deltaY)))
  const next = Math.floor(nextBase + visible / 2)
  if (next !== current) {
    editor.doc.song.channels[channel].octave = next
    editor.doc.notifier.changed()
  }
  event.preventDefault()
}, { passive: false })
const labels = {
  Play: '播放', Pause: '暂停', File: '文件', Edit: '编辑', Preferences: '设置',
  'Song Settings': '歌曲设置', 'Instrument Settings': '乐器设置',
  'Scale:': '音阶:', 'Key:': '调性:', 'Tempo:': '速度:', 'Rhythm:': '节奏:',
  'Volume:': '音量:', 'Type:': '音色:', 'Customize Instrument': '编辑乐器'
}
const translateUi = () => {
  const root = document.querySelector('.beepboxEditor .settings-area')
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const text = node.nodeValue.trim()
    if (labels[text]) node.nodeValue = node.nodeValue.replace(text, labels[text])
  }
}
translateUi()
let lastSong = ''
const sendSong = (type) => {
  if (window.parent === window) return
  const song = editor.doc.song.toBase64String()
  if (type !== 'ready' && song === lastSong) return
  lastSong = song
  const hasNotes = editor.doc.song.channels.some(channel => channel.bars.some(patternNumber => patternNumber > 0 && channel.patterns[patternNumber - 1]?.notes.length))
  window.parent.postMessage({ type: 'modmind-beepbox:' + type, song, hasNotes }, window.location.origin)
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin || !event.data) return
  if (event.data.type === 'modmind-beepbox:view' && ['notes', 'tracks', 'settings'].includes(event.data.view)) {
    document.documentElement.dataset.view = event.data.view
    editor.doc.notifier.changed()
    return
  }
  if (event.data.type !== 'modmind-beepbox:theme') return
  const theme = event.data.dark ? 'dark classic' : 'light classic'
  document.documentElement.style.colorScheme = event.data.dark ? 'dark' : 'light'
  if (editor.doc.prefs.colorTheme !== theme) {
    editor.doc.prefs.colorTheme = theme
    beepbox.ColorConfig.setTheme(theme)
  }
  const palette = event.data.palette || {}
  const values = {
    '--page-margin': palette.canvas,
    '--editor-background': palette.canvas,
    '--primary-text': palette.text,
    '--secondary-text': palette.muted,
    '--inverted-text': palette.onAction,
    '--ui-widget-background': palette.surface,
    '--ui-widget-focus': palette.selected,
    '--pitch-background': palette.panel,
    '--loop-accent': palette.accent,
    '--link-accent': palette.accent,
    '--hover-preview': palette.text,
    '--playhead': palette.text,
    '--modmind-line': palette.line,
    '--modmind-panel': palette.panel,
    '--modmind-action': palette.action,
    '--modmind-on-action': palette.onAction
  }
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && value) document.documentElement.style.setProperty(name, value)
  if (palette.accent && palette.surface) document.documentElement.style.setProperty('--tonic', `color-mix(in srgb, ${palette.accent} 19%, ${palette.surface})`)
  if (palette.accent && palette.panel) document.documentElement.style.setProperty('--fifth-note', `color-mix(in srgb, ${palette.accent} 12%, ${palette.panel})`)
  editor.doc.notifier.changed()
})
sendSong('ready')
updateTrackNavigation()
window.setInterval(() => { sendSong('changed'); translateUi(); updateTrackNavigation() }, 350)
