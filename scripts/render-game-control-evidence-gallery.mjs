import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

// Compact visual review of recorded game frames; never treated as gameplay
// assertions or substituted for the original pixel/hash evidence.
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const evidenceRoot = path.resolve(arg('evidence-root') || '.')
const report = JSON.parse(await fs.readFile(arg('report') || 'docs/game-control-compatibility/runtime-results.json', 'utf8'))
const directory = path.resolve(arg('output') || 'test-results/game-control-gallery')
const rows = report.rows.filter(row => row.status === 'runtime-verified')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const pages = []
await fs.mkdir(directory, { recursive: true })
for (let offset = 0; offset < rows.length; offset += 30) {
  const subset = rows.slice(offset, offset + 30), columns = 5, width = 300, height = 194
  const images = []
  for (let index = 0; index < subset.length; index++) {
    const row = subset[index], file = path.resolve(evidenceRoot, row.report)
    if (!file.startsWith(evidenceRoot + path.sep)) throw new Error('Evidence escaped root')
    const verification = JSON.parse(await fs.readFile(file, 'utf8'))
    const frame = path.resolve(path.dirname(file), verification.captures.after.path)
    if (!frame.startsWith(path.dirname(file) + path.sep)) throw new Error('Frame escaped owned directory')
    const x = index % columns * width, y = Math.floor(index / columns) * height
    images.push({ input: await sharp(frame).resize(width, 169, { fit: 'contain' }).png().toBuffer(), left: x, top: y + 25 })
    const label = escape(row.key || row.minecraftVersion)
    images.push({ input: Buffer.from(`<svg width="${width}" height="25"><rect width="100%" height="100%" fill="#20242a"/><text x="8" y="18" fill="white" font-size="13" font-family="Segoe UI">${label}</text></svg>`), left: x, top: y })
  }
  const file = path.join(directory, `after-${offset / 30 + 1}.png`)
  await sharp({ create: { width: columns * width, height: Math.ceil(subset.length / columns) * height, channels: 3, background: '#111111' } }).composite(images).png().toFile(file)
  pages.push({ file, keys: subset.map(row => row.key || row.minecraftVersion) })
}
await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sourceReport: arg('report'), reviewedFrames: rows.length, purpose: 'visual review only; original PNGs and machine checks remain authoritative', pages }, null, 2))
console.log(JSON.stringify({ frames: rows.length, pages: pages.map(page => page.file) }))
