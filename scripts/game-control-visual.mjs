import sharp from 'sharp'

// Acceptance-only recognition of the first full-width title-menu button.
// NeoForge adds a Mods row and shifts Singleplayer upward; a fixed y coordinate
// would click Multiplayer. This reads only the returned game image.
export async function findTitlePlayButton(png) {
  const { data, info } = await sharp(png).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const scale = info.width / 960, x = value => Math.round(value * scale), y = value => Math.round(value * info.height / 540)
  const pixel = (column, row) => [...data.subarray((row * info.width + column) * 3, (row * info.width + column) * 3 + 3)]
  const dark = value => Math.max(...value) < 35
  const light = value => value.reduce((sum, channel) => sum + channel, 0) / 3
  const button = row => {
    const left = pixel(x(280), row), right = pixel(x(679), row)
    // Older titles fade in over a colored panorama, so even the gray button
    // inherits a blue/green tint. Recognize its two vertical borders instead.
    const borders = dark(left) && dark(right) || light(left) + 12 < light(pixel(x(278), row)) && light(right) + 12 < light(pixel(x(681), row))
    return borders && [300, 330].every(column => light(pixel(x(column), row)) > light(left) + 22) && [630, 650].every(column => light(pixel(x(column), row)) > light(right) + 22)
  }
  let start
  for (let row = y(175); row <= y(310); row++) {
    if (!button(row)) { start = undefined; continue }
    start ??= row
    if (row - start >= y(16)) return { x: Math.round(info.width / 2), y: start + y(16), source: 'first visible title-menu button' }
  }
  return undefined
}

// Acceptance-only guard for the experimental world-creation confirmation seen
// in NeoForge 20.5.21-beta. Called only immediately after Create New World in
// a fresh isolated fixture, never as a general-purpose Yes-dialog handler.
export async function findExperimentalWorldConfirmation(png) {
  const { data, info } = await sharp(png).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const x = value => Math.round(value * info.width / 960), y = value => Math.round(value * info.height / 540)
  const pixel = (column, row) => [...data.subarray((y(row) * info.width + x(column)) * 3, (y(row) * info.width + x(column)) * 3 + 3)]
  const dark = value => Math.max(...value) < 40
  if (![170, 469, 490, 789].every(column => [286, 310].every(row => dark(pixel(column, row))))) return
  if (![200, 520].every(column => Math.min(...pixel(column, 290)) > 80)) return
  const whiteCount = (left, top, right, bottom) => {
    let count = 0
    for (let row = y(top); row < y(bottom); row++) for (let column = x(left); column < x(right); column++) {
      const offset = (row * info.width + column) * 3
      if (data[offset] > 210 && data[offset + 1] > 210 && data[offset + 2] > 210) count++
    }
    return count
  }
  if (whiteCount(190, 158, 780, 180) < 400 || whiteCount(70, 196, 890, 234) < 700) return
  return { x: x(320), y: y(300), source: 'observed experimental-world confirmation in isolated NeoForge 1.20.5 fixture' }
}
