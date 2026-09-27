const writeWav = (left, right, gain) => {
  const frames = left.length
  const bytes = new Uint8Array(44 + frames * 4)
  const view = new DataView(bytes.buffer)
  const label = (offset, value) => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index) }
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, 44100, true); view.setUint32(28, 44100 * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true)
  label(36, 'data'); view.setUint32(40, frames * 4, true)
  for (let index = 0; index < frames; index++) {
    view.setInt16(44 + index * 4, Math.max(-32768, Math.min(32767, Math.round(left[index] * gain * 32767))), true)
    view.setInt16(46 + index * 4, Math.max(-32768, Math.min(32767, Math.round(right[index] * gain * 32767))), true)
  }
  return bytes
}
window.addEventListener('message', async event => {
  if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'modmind-beepbox:render') return
  const { id, encoded, gain } = event.data
  try {
    if (typeof id !== 'string' || typeof encoded !== 'string' || encoded.length > 200000) throw new Error('音乐工程无效或过大')
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < .01 || gain > 1) throw new Error('音乐总音量无效')
    const song = new beepbox.Song(encoded)
    if (!song.channels.some(channel => channel.bars.some(number => number > 0 && channel.patterns[number - 1]?.notes.length))) throw new Error('音乐编排还没有可播放的音符')
    const synth = new beepbox.Synth(song)
    synth.samplesPerSecond = 44100
    synth.loopRepeatCount = 0
    const frames = Math.ceil(synth.getSamplesPerBar() * synth.getTotalBars(true, true))
    if (!Number.isFinite(frames) || frames < 1 || frames > 44100 * 90) throw new Error('音乐时长超过 90 秒，请缩短作品')
    const left = new Float32Array(frames), right = new Float32Array(frames)
    for (let offset = 0; offset < frames; offset += 131072) {
      const end = Math.min(frames, offset + 131072)
      synth.synthesize(left.subarray(offset, end), right.subarray(offset, end), end - offset)
      if (offset % 524288 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    const wav = writeWav(left, right, gain)
    window.parent.postMessage({ type: 'modmind-beepbox:rendered', id, bytes: wav }, window.location.origin, [wav.buffer])
  } catch (error) {
    window.parent.postMessage({ type: 'modmind-beepbox:rendered', id, error: String(error) }, window.location.origin)
  }
})
window.parent.postMessage({ type: 'modmind-beepbox:render-ready' }, window.location.origin)
