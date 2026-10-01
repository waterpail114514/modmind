import sharp from 'sharp'
import type {
  ReferenceImageAnalysis,
  ReferenceImageAssetCandidate,
  ReferenceImageAssetProgram
} from "../../../../src/shared/advancedAsset"
import type {BlockbenchAction, BlockbenchVector2} from "../../../../src/shared/blockbench"
import {compileAdvancedAsset} from "./advancedAssetCompiler"

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

export async function compileReferenceImageAsset(input: unknown): Promise<ReferenceImageAssetCandidate> {
  const request = normalizeReferenceRequest(input)
  const buffer = decodeImageDataUrl(request.image.dataUrl)
  const analysis = await analyzeReferenceImage(buffer, request)
  const profile = scaleProfile(analysis.profilePoints, analysis.width, analysis.height)
  const textureSize = Math.max(16, Math.min(1024, request.model?.textureWidth ?? nearestPowerOfTwo(analysis.width)))
  const textureHeight = Math.max(16, Math.min(1024, request.model?.textureHeight ?? nearestPowerOfTwo(analysis.height)))
  const texturePng = await sharp(buffer).rotate().resize(textureSize, textureHeight, {fit: 'contain', background: '#00000000', kernel: 'nearest'}).png().toBuffer()
  const textureDataUrl = `data:image/png;base64,${texturePng.toString('base64')}`
  const candidate = compileAdvancedAsset({
    version: 1,
    metadata: {...request.metadata, symmetry: analysis.symmetry >= 0.78 ? 'bilateral' : 'asymmetric'},
    model: {
      format: request.model?.format ?? 'free', textureWidth: textureSize, textureHeight,
      primitives: [{id: 'reference_profile', type: 'extrude', profile, depth: request.image.depth ?? 2, shading: 'flat'}]
    },
    texture: {name: `${slug(request.metadata.name)}_reference`, width: textureSize, height: textureHeight, fill: analysis.dominantColors[0] ?? '#808080ff'},
    rig: request.rig,
    animations: request.animations
  })
  const actions = candidate.actions.flatMap((action): BlockbenchAction[] => {
    if (action.type === 'create-texture') return [{...action, dataUrl: textureDataUrl, fill: undefined, rectangles: undefined}]
    if (action.type === 'auto-unwrap-mesh' && action.meshName === 'reference_profile_mesh') return []
    if (action.type !== 'add-mesh' || action.name !== 'reference_profile_mesh') return [action]
    const points = Object.values(action.vertices)
    const minimumX = Math.min(...points.map((point) => point[0])), maximumX = Math.max(...points.map((point) => point[0]))
    const minimumY = Math.min(...points.map((point) => point[1])), maximumY = Math.max(...points.map((point) => point[1]))
    const faces = action.faces.map((face) => ({
      ...face,
      uv: Object.fromEntries(face.vertices.map((vertex) => {
        const point = action.vertices[vertex]
        return [vertex, [
          Number(((point[0] - minimumX) / Math.max(0.0001, maximumX - minimumX) * textureSize).toFixed(4)),
          Number(((maximumY - point[1]) / Math.max(0.0001, maximumY - minimumY) * textureHeight).toFixed(4))
        ] as BlockbenchVector2]
      }))
    }))
    return [{...action, faces}]
  })
  return {...candidate, actions, reference: analysis}
}

export async function analyzeReferenceImage(buffer: Buffer, request?: ReferenceImageAssetProgram): Promise<ReferenceImageAnalysis> {
  const image = sharp(buffer, {limitInputPixels: 16_777_216}).rotate().ensureAlpha()
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Reference image dimensions are unavailable')
  const scale = Math.min(1, 256 / Math.max(metadata.width, metadata.height))
  const prepared = scale < 1 ? image.resize(Math.max(1, Math.round(metadata.width * scale)), Math.max(1, Math.round(metadata.height * scale)), {fit: 'fill'}) : image
  const {data, info} = await prepared.raw().toBuffer({resolveWithObject: true})
  const threshold = request?.image.alphaThreshold ?? 16
  const background = cornerColor(data, info.width, info.height)
  const hasTransparency = hasTransparentPixel(data, threshold)
  const foreground = new Uint8Array(info.width * info.height)
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    const offset = (y * info.width + x) * 4
    const alpha = data[offset + 3]
    const distance = colorDistance(data[offset], data[offset + 1], data[offset + 2], background)
    foreground[y * info.width + x] = alpha > threshold && (hasTransparency || distance > 24) ? 1 : 0
  }
  let bounds = foregroundBounds(foreground, info.width, info.height)
  if (!bounds) {
    foreground.fill(1)
    bounds = {left: 0, top: 0, right: info.width - 1, bottom: info.height - 1}
  }
  const maxPoints = clampInteger(request?.image.maxProfilePoints ?? 48, 8, 128)
  const profilePoints = outlineProfile(foreground, info.width, bounds, maxPoints)
    .map(([x, y]) => [Number((x / scale).toFixed(4)), Number((y / scale).toFixed(4))] as BlockbenchVector2)
  const dominantColors = dominantPalette(data, foreground, 5)
  const symmetry = silhouetteSymmetry(foreground, info.width, info.height, bounds)
  return {
    width: metadata.width, height: metadata.height,
    alphaBounds: {
      left: Math.round(bounds.left / scale), top: Math.round(bounds.top / scale),
      right: Math.round(bounds.right / scale), bottom: Math.round(bounds.bottom / scale)
    },
    dominantColors, profilePoints, symmetry: Number(symmetry.toFixed(4))
  }
}

function normalizeReferenceRequest(input: unknown): ReferenceImageAssetProgram {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Reference image asset request must be an object')
  const request = structuredClone(input) as ReferenceImageAssetProgram
  if (request.version !== 1) throw new Error('Unsupported reference image asset version')
  if (!request.metadata || typeof request.metadata.name !== 'string' || !request.metadata.name.trim()) throw new Error('Reference image metadata.name is required')
  if (!request.image || typeof request.image.dataUrl !== 'string') throw new Error('Reference image dataUrl is required')
  if (request.image.depth !== undefined && (!Number.isFinite(request.image.depth) || request.image.depth <= 0 || request.image.depth > 256)) throw new Error('Reference image depth must be greater than 0 and at most 256')
  return request
}

function decodeImageDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Reference image must be a PNG, JPEG, or WebP data URL')
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES) throw new Error('Reference image size is invalid')
  return buffer
}

function foregroundBounds(mask: Uint8Array, width: number, height: number): {left: number; top: number; right: number; bottom: number} | null {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
  }
  return right >= left ? {left, top, right, bottom} : null
}

function outlineProfile(
  mask: Uint8Array,
  width: number,
  bounds: {left: number; top: number; right: number; bottom: number},
  maximum: number
): BlockbenchVector2[] {
  const rows: Array<{y: number; left: number; right: number}> = []
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    let left = width, right = -1
    for (let x = bounds.left; x <= bounds.right; x += 1) if (mask[y * width + x]) { left = Math.min(left, x); right = Math.max(right, x) }
    if (right >= left) rows.push({y, left, right})
  }
  const perSide = Math.max(4, Math.floor(maximum / 2))
  const sampled = sampleEvenly(rows, perSide)
  const polygon = [...sampled.map((row) => [row.left, row.y] as BlockbenchVector2), ...[...sampled].reverse().map((row) => [row.right, row.y] as BlockbenchVector2)]
  return removeDuplicatePoints(polygon)
}

function scaleProfile(points: BlockbenchVector2[], width: number, height: number): BlockbenchVector2[] {
  const targetHeight = 16
  const scale = targetHeight / Math.max(1, height)
  return points.map(([x, y]) => [Number(((x - width / 2) * scale).toFixed(4)), Number(((height / 2 - y) * scale).toFixed(4))])
}

function dominantPalette(data: Buffer, foreground: Uint8Array, count: number): string[] {
  const buckets = new Map<number, number>()
  for (let pixel = 0; pixel < foreground.length; pixel += 1) {
    if (!foreground[pixel]) continue
    const offset = pixel * 4
    const key = (data[offset] >> 4) << 8 | (data[offset + 1] >> 4) << 4 | (data[offset + 2] >> 4)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return [...buckets.entries()].sort((left, right) => right[1] - left[1]).slice(0, count).map(([key]) => {
    const red = ((key >> 8) & 15) * 17, green = ((key >> 4) & 15) * 17, blue = (key & 15) * 17
    return `#${[red, green, blue, 255].map((value) => value.toString(16).padStart(2, '0')).join('')}`
  })
}

function silhouetteSymmetry(mask: Uint8Array, width: number, height: number, bounds: {left: number; right: number}): number {
  const center = (bounds.left + bounds.right) / 2
  let matches = 0, total = 0
  for (let y = 0; y < height; y += 1) for (let x = bounds.left; x <= Math.floor(center); x += 1) {
    const mirror = Math.round(center + (center - x))
    if (mirror >= width) continue
    total += 1
    if (mask[y * width + x] === mask[y * width + mirror]) matches += 1
  }
  return total ? matches / total : 1
}

function cornerColor(data: Buffer, width: number, height: number): [number, number, number] {
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  return [0, 1, 2].map((channel) => Math.round(points.reduce((sum, [x, y]) => sum + data[(y * width + x) * 4 + channel], 0) / points.length)) as [number, number, number]
}

function hasTransparentPixel(data: Buffer, threshold: number): boolean {
  for (let offset = 3; offset < data.length; offset += 4) if (data[offset] <= threshold) return true
  return false
}

function colorDistance(red: number, green: number, blue: number, background: [number, number, number]): number {
  return Math.hypot(red - background[0], green - background[1], blue - background[2])
}

function sampleEvenly<T>(items: T[], maximum: number): T[] {
  if (items.length <= maximum) return items
  return Array.from({length: maximum}, (_, index) => items[Math.round(index * (items.length - 1) / (maximum - 1))])
}

function removeDuplicatePoints(points: BlockbenchVector2[]): BlockbenchVector2[] {
  return points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
}

function nearestPowerOfTwo(value: number): number {
  return 2 ** Math.round(Math.log2(Math.max(16, value)))
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'reference'
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}
