import { promises as fs } from 'node:fs'
import sharp from 'sharp'

const source = 'logo.png'
const metadata = await sharp(source).metadata()
if (metadata.width < 1024 || metadata.height < 1024) throw new Error('ICNS requires a source of at least 1024×1024')
const chunks = []
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
  const png = await sharp(source).resize(size, size, { fit: 'contain' }).png().toBuffer()
  const header = Buffer.alloc(8)
  header.write(type); header.writeUInt32BE(png.length + 8, 4)
  chunks.push(header, png)
}
const header = Buffer.alloc(8)
header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, b) => sum + b.length, 0), 4)
await fs.writeFile('resources/icon.icns', Buffer.concat([header, ...chunks]))
// A small monochrome M stays legible after macOS applies its menu-bar tint.
const template = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="black" d="M3 18V4h3l5 7 5-7h3v14h-3V9l-5 7-5-7v9z"/></svg>')
for (const scale of [1, 2]) await sharp(template).resize(22 * scale, 22 * scale).png().toFile(`resources/trayTemplate${scale === 2 ? '@2x' : ''}.png`)
console.log('Generated ICNS and macOS template icons')
