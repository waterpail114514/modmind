import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const server = await createServer({
  configFile: false,
  root: path.join(root, 'src/renderer'),
  publicDir: path.join(root, 'resources/renderer-public'),
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } },
  plugins: [react(), { name: 'minimal-preview', configureServer(server) {
    server.middlewares.use('/preview', async (_request, response, next) => {
      try { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await readFile(path.join(root, 'prototypes/beginner-minimal.html'), 'utf8')) }
      catch (error) { next(error) }
    })
  } }],
  server: { host: '127.0.0.1', port: 5174, strictPort: false, fs: { allow: [root] } }
})
await server.listen()
server.printUrls()
