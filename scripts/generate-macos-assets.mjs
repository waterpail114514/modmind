import { promises as fs } from 'node:fs'
import sharp from 'sharp'

const source = 'logo.png'
const metadata = await sharp(source).metadata()
if (!metadata.hasAlpha) throw new Error('Logo must preserve transparency')
const chunks = []
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
  const png = await sharp(source).resize(size, size, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  const header = Buffer.alloc(8)
  header.write(type); header.writeUInt32BE(png.length + 8, 4)
  chunks.push(header, png)
}
const header = Buffer.alloc(8)
header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, b) => sum + b.length, 0), 4)
await fs.writeFile('resources/icon.icns', Buffer.concat([header, ...chunks]))
// The menu-bar template uses the same logo silhouette with macOS tinting.
for (const scale of [1, 2]) {
  const { data, info } = await sharp(source).resize(22 * scale, 22 * scale, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 0
  await sharp(data, { raw: info }).png().toFile(`resources/trayTemplate${scale === 2 ? '@2x' : ''}.png`)
}
console.log('Generated ICNS and macOS template icons')