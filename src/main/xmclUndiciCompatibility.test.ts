import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { Agent, errors, interceptors } from 'undici'
import { download } from '@xmcl/file-transfer'
import { ensureXmclUndiciCompatibility } from './xmclUndiciCompatibility'

it('recovers from a real failed XMCL download source using the Undici 7 error API', async () => {
  ensureXmclUndiciCompatibility()
  const adapter = Object.getOwnPropertyDescriptor(errors, 'ResponseStatusCodeError')?.value
  ensureXmclUndiciCompatibility(); expect(Object.getOwnPropertyDescriptor(errors, 'ResponseStatusCodeError')?.value).toBe(adapter)
  const bytes = Buffer.from('real fallback payload'), requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url || '')
    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return }
    res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-xmcl-undici-')), dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: 5 }))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const destination = path.join(root, 'payload')
    await download({ url: [base + '/missing', base + '/valid'], destination, dispatcher, validator: { algorithm: 'sha1', hash: createHash('sha1').update(bytes).digest('hex') } })
    expect(requests).toContain('/missing'); expect(requests).toContain('/valid'); expect(await fs.readFile(destination)).toEqual(bytes)
  } finally { await dispatcher.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }) }
}, 15000)
