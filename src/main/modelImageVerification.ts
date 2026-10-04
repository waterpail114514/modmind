import { randomInt } from 'node:crypto'
import sharp from 'sharp'
import type { ModelImageVerification } from '../shared/types'
import type { ModelImageCapabilities } from './modelImageCapabilities'

interface Connection { baseUrl: string; apiKey: string; model: string }
const palette = [{ code: 'R', color: '#ff0000' }, { code: 'G', color: '#00ff00' }, { code: 'B', color: '#0000ff' }, { code: 'Y', color: '#ffff00' }]

async function challenge(): Promise<{ image: string; expected: string[] }> {
  const tiles = Array.from({ length: 9 }, () => palette[randomInt(palette.length)])
  const composites = await Promise.all(tiles.map(async (tile, i) => ({
    input: await sharp({ create: { width: 96, height: 96, channels: 3, background: tile.color } }).png().toBuffer(),
    left: i % 3 * 96, top: Math.floor(i / 3) * 96
  })))
  const png = await sharp({ create: { width: 288, height: 288, channels: 3, background: '#ffffff' } }).composite(composites).png().toBuffer()
  return { image: `data:image/png;base64,${png.toString('base64')}`, expected: tiles.map(tile => tile.code) }
}

function outputText(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text
  return Array.isArray(response?.output) ? response.output.filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => Array.isArray(item.content) ? item.content : []).filter((part: any) => part?.type === 'output_text').map((part: any) => part.text ?? '').join('') : ''
}

async function readAnswer(response: Response): Promise<string> {
  if (!response.body) throw new Error('上游未返回识图结果')
  const decoder = new TextDecoder(), chunks: string[] = []
  let bytes = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength
    if (bytes > 128 * 1024) throw new Error('识图验证响应超过大小限制')
    chunks.push(decoder.decode(chunk, { stream: true }))
  }
  const body = chunks.join('') + decoder.decode()
  if (!response.ok) throw new Error(`识图请求被上游拒绝（HTTP ${response.status}）`)
  try {
    const payload = JSON.parse(body)
    if (payload.error || payload.status !== 'completed') throw new Error('识图请求未完成')
    return outputText(payload)
  } catch (error) { if (error instanceof Error && !(error instanceof SyntaxError)) throw error }
  let completed = false, failed = false, text = '', deltas = ''
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') continue
    let event: any
    try { event = JSON.parse(data) } catch { continue }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') failed = true
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') deltas += event.delta
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') text += outputText({ output: [event.item] })
    if (event.type === 'response.completed') { completed = true; text = outputText(event.response) || text }
  }
  if (!completed || failed) throw new Error('识图请求未完成，请重试')
  return text || deltas
}

export async function verifyModelImageInput(connection: Connection, capabilities: ModelImageCapabilities,
  request: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>): Promise<ModelImageVerification> {
  await capabilities.load()
  const { image, expected } = await challenge()
  const body = { model: connection.model, stream: true, max_output_tokens: 2048, input: [{ type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'Read the attached 3 by 3 color grid. Return ONLY a JSON array of 9 color codes in row-major order, left to right then top to bottom. R=red, G=green, B=blue, Y=yellow. Determine the arrangement from the image.' },
    { type: 'input_image', image_url: image }
  ] }] }
  let reason: string | undefined
  try {
    const answer = (await readAnswer(await request(body, AbortSignal.timeout(30_000)))).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const codes = JSON.parse(answer)
    if (Array.isArray(codes) && codes.length === expected.length && codes.every((code, i) => code === expected[i])) {
      return { model: connection.model, verified: true, imageInput: await capabilities.verified(connection.baseUrl, connection.apiKey, connection.model) }
    }
    reason = '色块排列识别未通过；这不能单独证明模型不支持图像'
  } catch (error) {
    reason = error instanceof SyntaxError ? '上游未返回可验证的色块排列，请重试' : error instanceof Error ? error.message : '识图验证失败，请重试'
  }
  await capabilities.invalidateVerification(connection.baseUrl, connection.apiKey, connection.model)
  return { model: connection.model, verified: false, imageInput: capabilities.resolve(connection.baseUrl, connection.apiKey, connection.model), reason }
}
