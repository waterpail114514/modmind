import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Set before Vite starts esbuild so it avoids the locked Windows user temp folder.
if (process.platform === 'win32') {
  const temporary = fileURLToPath(new URL('../node_modules/.cache/modmind-vite/tmp/', import.meta.url))
  mkdirSync(temporary, { recursive: true })
  process.env.TEMP = temporary
  process.env.TMP = temporary
}

await import('../node_modules/electron-vite/bin/electron-vite.js')
