import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconPath = path.join(root, 'resources', 'icon.png')

function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil(width * 3 / 4) * 4
  const pixelBytes = rowSize * height
  const output = Buffer.alloc(54 + pixelBytes)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18)
  output.writeInt32LE(height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelBytes, 34)
  output.writeInt32LE(3780, 38)
  output.writeInt32LE(3780, 42)

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width * 3
    const targetRow = 54 + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 3
      const target = targetRow + x * 3
      output[target] = rgb[source + 2]
      output[target + 1] = rgb[source + 1]
      output[target + 2] = rgb[source]
    }
  }
  return output
}

async function renderBmp(width, height, background, layers, target) {
  const { data } = await sharp({ create: { width, height, channels: 4, background } })
    .composite(layers)
    .flatten({ background })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  await fs.writeFile(path.join(root, 'resources', target), encodeBmp(width, height, data))
}

const sidebarIcon = await sharp(iconPath)
  .resize(192, 192, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extract({ left: 14, top: 0, width: 164, height: 192 })
  .png()
  .toBuffer()
const headerIcon = await sharp(iconPath).trim().resize(48, 48, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
const sidebarText = Buffer.from(`
  <svg width="164" height="314" xmlns="http://www.w3.org/2000/svg">
    <style>
      .brand { font: 700 19px 'Segoe UI', 'Microsoft YaHei', sans-serif; fill: #202226; }
      .meta { font: 600 8px 'Segoe UI', 'Microsoft YaHei', sans-serif; fill: #6f7278; letter-spacing: 1px; }
    </style>
    <rect x="0" y="0" width="4" height="314" fill="#1677e8"/>
    <text x="18" y="34" class="brand">ModMind</text>
    <text x="18" y="51" class="meta">MINECRAFT CREATION</text>
    <line x1="18" y1="272" x2="145" y2="272" stroke="#d7d9de" stroke-width="1"/>
    <text x="18" y="292" class="meta">BUILD  ·  TEST  ·  SHIP</text>
  </svg>
`)
const headerAccent = Buffer.from(`
  <svg width="150" height="57" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="150" height="57" fill="#ffffff"/>
    <rect x="146" y="0" width="4" height="57" fill="#1677e8"/>
    <line x1="0" y1="56" x2="150" y2="56" stroke="#e2e4e7" stroke-width="1"/>
  </svg>
`)

await renderBmp(164, 314, '#f1f2f4', [
  { input: sidebarIcon, left: 0, top: 66 },
  { input: sidebarText, left: 0, top: 0 }
], 'installer-sidebar.bmp')

await renderBmp(150, 57, '#ffffff', [
  { input: headerAccent, left: 0, top: 0 },
  { input: headerIcon, left: 94, top: 4 }
], 'installer-header.bmp')

console.log('Generated resources/installer-sidebar.bmp and resources/installer-header.bmp')
