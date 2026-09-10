import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatCompletionsAdapter } from './chatCompletionsAdapter'
import { LiveConfiguration } from './liveConfiguration'
import { runExternalAgent, type ExternalAgentBridgeHandlers, type ExternalAgentRunOptions } from './externalAgents'
import type { ProjectInfo } from '../shared/types'

const executable = process.env.MODMIND_TEST_CODEX

describe.skipIf(!executable)('bundled Codex hot switch with local providers', () => {
  it('changes a live provider without manual recovery and resumes foreign history with the selected model', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-hot-switch-native-'))
    const home = path.join(root, 'home')
    await fs.mkdir(home)
    const project: ProjectInfo = { name: 'Hot Switch', path: root, namespace: 'hot_switch', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: new Date().toISOString() }
    const live = new LiveConfiguration()
    const adapter = new ChatCompletionsAdapter()
    const requests: Array<{ provider: string; model: string; input: unknown[]; authorization: string }> = []
    let firstRequest!: () => void
    const first = new Promise<void>(resolve => { firstRequest = resolve })
    let oldClosed!: () => void
    const oldDisconnected = new Promise<void>(resolve => { oldClosed = resolve })
    const servers: Server[] = []
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 70_000)
    const provider = async (label: string): Promise<string> => {
      const server = createServer(async (request, response) => {
        if (request.url !== '/v1/responses') { response.writeHead(404); response.end(); return }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        requests.push({ provider: label, model: body.model, input: body.input, authorization: request.headers.authorization || '' })
        if (label === 'A') { response.once('close', oldClosed); firstRequest(); return }
        if (label === 'free' && body.input.some((item: { type?: string; id?: string }) => item.type === 'message' && item.id && !item.id.startsWith('msg_'))) {
          response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Invalid id: expected msg_' } })); return
        }
        const message = { type: 'message', id: label === 'B' ? 'item_foreign_history' : 'msg_free_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'HS-47 continued successfully.', annotations: [] }] }
        const events = [
          { type: 'response.created', response: { id: 'resp_' + label, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: { id: 'resp_' + label, status: 'completed', output: [message], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      })
      servers.push(server)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    }
    let running: Promise<unknown> | undefined
    try {
      const a = await provider('A')
      const b = await provider('B')
      const free = await provider('free')
      let current = { url: a, model: 'gpt-5.6-terra', key: 'test-A' }
      const handlers = new Proxy({ projectInfo: { name: project.name } }, { get: (target, property) => property === 'projectInfo' ? target.projectInfo : async () => ({ ok: true }) }) as unknown as ExternalAgentBridgeHandlers
      const options: ExternalAgentRunOptions = {
        kind: 'codex', executable, forceCodexAppServer: true, project, readOnly: true,
        prompt: 'Remember HS-47. Answer briefly without calling tools.', signal: controller.signal,
        liveConfiguration: live,
        refreshConfiguration: async () => {
          const revision = live.current()
          const url = await adapter.baseUrl(current.url, String(revision.sequence), revision.signal)
          return {
            model: current.model, modelProvider: 'test', sessionHome: home,
            env: { CODEX_HOME: home, MODMIND_TEST_KEY: current.key },
            providerConfig: {
              'model_providers.test': { name: 'Local integration fixture', base_url: url, env_key: 'MODMIND_TEST_KEY', wire_api: 'responses' },
              'features.enable_request_compression': false
            }
          }
        },
        onOutput: () => undefined, onProgress: () => undefined, bridge: handlers
      }
      const task = runExternalAgent(options)
      running = task
      await Promise.race([first, task.then(() => { throw new Error('A unexpectedly completed') })])
      const revision = live.begin()
      current = { url: b, model: 'gpt-5.6-sol', key: 'test-B' }
      live.finish(revision)
      const result = await task
      await oldDisconnected
      expect(result.summary).toContain('HS-47')
      expect(requests.map(request => request.provider)).toEqual(['A', 'B'])
      expect(requests[1]).toMatchObject({ model: 'gpt-5.6-sol', authorization: 'Bearer test-B' })
      const freeRevision = live.begin()
      current = { url: free, model: 'qwen3.8-flash', key: 'test-free' }
      live.finish(freeRevision)
      const continued = runExternalAgent({ ...options, sessionId: result.sessionId, resumeSession: true, prompt: 'Continue with the same marker.' })
      running = continued
      expect((await continued).summary).toContain('HS-47')
      expect(requests.at(-1)).toMatchObject({ provider: 'free', model: 'qwen3.8-flash', authorization: 'Bearer test-free' })
      expect(JSON.stringify(requests.at(-1)?.input)).toContain('HS-47')
      expect(JSON.stringify(requests.at(-1)?.input)).not.toContain('"id":"item_foreign_history"')
      expect((requests.at(-1)?.input as Array<{ role?: string }>).some(item => item.role === 'assistant')).toBe(true)
    } finally {
      controller.abort()
      await running?.catch(() => undefined)
      clearTimeout(timeout)
      adapter.close()
      for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 80_000)
})
