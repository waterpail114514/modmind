// Generates all launcher icons and splash screens from ../../logo.png.
// Run: node scripts/generate-icons.mjs
import sharp from 'sharp'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const resDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'main', 'res')
const logo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logo.png')

const launcherSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
const foregroundSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }

async function generateForeground(dpi, size) {
  // Adaptive-icon layers are square canvases; the outer ~18% on each side may be
  // masked away by the launcher, so the logo only uses the central ~66%.
  const inner = Math.round(size * 0.66)
  const logoPng = await sharp(logo).resize(inner, inner, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logoPng, gravity: 'center' }])
    .png()
    .toFile(join(resDir, `mipmap-${dpi}`, 'ic_launcher_foreground.png'))
}

async function generateLauncher(dpi, size) {
  await sharp(logo)
    .resize(size, size, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(resDir, `mipmap-${dpi}`, 'ic_launcher.png'))
  await sharp(logo)
    .resize(size, size, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#0B0F14" opacity="1"/></svg>`),
      blend: 'dest-in'
    }])
    .png()
    .toFile(join(resDir, `mipmap-${dpi}`, 'ic_launcher_round.png'))
}

for (const [dpi, size] of Object.entries(foregroundSizes)) await generateForeground(dpi, size)
for (const [dpi, size] of Object.entries(launcherSizes)) await generateLauncher(dpi, size)

console.log(`Generated foregrounds and launcher icons into ${resDir}`)
