import sharp from 'sharp'
import type {AssetVisualReview} from '../shared/advancedAsset'
import type {BlockbenchCaptureFrame} from '../shared/blockbench'

interface FrameMetrics {
  view: string
  heightToWidth: number | null
  occupancy: number
  contrast: number
  edgeDensity: number
  symmetry: number
  clippingRisk: number
}

export async function reviewAssetCaptures(captures: BlockbenchCaptureFrame[], referenceHeightToWidth?: number): Promise<AssetVisualReview> {
  if (!Array.isArray(captures) || captures.length < 1 || captures.length > 6) throw new Error('Visual review requires 1 to 6 captures')
  if (referenceHeightToWidth !== undefined && (!Number.isFinite(referenceHeightToWidth) || referenceHeightToWidth < 0.2 || referenceHeightToWidth > 8)) {
    throw new Error('Reference height-to-width ratio must be between 0.2 and 8')
  }
  const frames = await Promise.all(captures.map(analyzeFrame))
  const occupancy = average(frames.map((frame) => frame.occupancy))
  const contrast = average(frames.map((frame) => frame.contrast))
  const edgeDensity = average(frames.map((frame) => frame.edgeDensity))
  const symmetryFrame = frames.find((frame) => frame.view === 'north' || frame.view === 'south') ?? frames[0]
  const symmetry = symmetryFrame.symmetry
  const clippingRisk = Math.max(...frames.map((frame) => frame.clippingRisk))
  const viewConsistency = consistency(frames.map((frame) => frame.occupancy))
  const occupancyScore = clamp(1 - Math.abs(occupancy - 0.34) / 0.34)
  const detailScore = clamp(edgeDensity / 0.12)
  const score = Math.round(100 * (
    occupancyScore * 0.2 + contrast * 0.2 + detailScore * 0.14 + symmetry * 0.13
    + (1 - clippingRisk) * 0.18 + viewConsistency * 0.15
  ))
  const findings: AssetVisualReview['findings'] = []
  if (occupancy < 0.14) findings.push({severity: 'warning', checkId: 'low-occupancy', message: 'The model occupies too little of the review frame', metric: occupancy})
  if (occupancy > 0.7) findings.push({severity: 'warning', checkId: 'high-occupancy', message: 'The model is too close to the review frame edges', metric: occupancy})
  if (contrast < 0.2) findings.push({severity: 'warning', checkId: 'low-contrast', message: 'Shape and texture contrast are too weak for reliable visual reading', metric: contrast})
  if (edgeDensity < 0.015) findings.push({severity: 'warning', checkId: 'low-detail', message: 'The rendered silhouette has very little structural detail', metric: edgeDensity})
  if (clippingRisk > 0.08) findings.push({severity: 'error', checkId: 'frame-clipping', message: 'Foreground pixels touch the capture boundary', metric: clippingRisk})
  if (symmetry < 0.62) findings.push({severity: 'info', checkId: 'asymmetry', message: 'The front silhouette is strongly asymmetric', view: symmetryFrame.view, metric: symmetry})
  if (viewConsistency < 0.55) findings.push({severity: 'warning', checkId: 'view-inconsistency', message: 'Model occupancy varies sharply between review angles', metric: viewConsistency})
  if (referenceHeightToWidth !== undefined) {
    const front = frames.find((frame) => frame.view === 'north' || frame.view === 'south')
    if (!front?.heightToWidth) {
      findings.push({severity: 'error', checkId: 'proportion-view-missing', message: 'A north or south capture is required to compare reference proportions'})
    } else if (front.heightToWidth / referenceHeightToWidth < 0.75 || front.heightToWidth / referenceHeightToWidth > 1.33) {
      findings.push({severity: 'error', checkId: 'reference-proportion-mismatch', message: `Front silhouette height-to-width ratio ${front.heightToWidth.toFixed(2)} differs from reference ${referenceHeightToWidth.toFixed(2)}`, view: front.view, metric: front.heightToWidth})
    }
  }
  if (!findings.length) findings.push({severity: 'info', checkId: 'visual-pass', message: 'Visual review found no framing, contrast, or silhouette blockers'})
  return {
    score,
    metrics: {occupancy, contrast, edgeDensity, symmetry, clippingRisk, viewConsistency},
    findings
  }
}

async function analyzeFrame(frame: BlockbenchCaptureFrame): Promise<FrameMetrics> {
  const buffer = decodeCapture(frame.dataUrl)
  const {data, info} = await sharp(buffer).resize(128, 128, {fit: 'fill'}).removeAlpha().raw().toBuffer({resolveWithObject: true})
  const background = cornerColor(data, info.width, info.height, info.channels)
  const mask = new Uint8Array(info.width * info.height)
  let graySum = 0, graySquared = 0, foregroundCount = 0, borderForeground = 0, edgeCount = 0, comparisons = 0
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1
  const gray = new Float32Array(mask.length)
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    const pixel = y * info.width + x, offset = pixel * info.channels
    const value = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
    gray[pixel] = value; graySum += value; graySquared += value * value
    const foreground = Math.hypot(data[offset] - background[0], data[offset + 1] - background[1], data[offset + 2] - background[2]) > 28
    mask[pixel] = foreground ? 1 : 0
    if (foreground) {
      foregroundCount += 1
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (x <= 1 || y <= 1 || x >= info.width - 2 || y >= info.height - 2) borderForeground += 1
    }
  }
  for (let y = 1; y < info.height; y += 1) for (let x = 1; x < info.width; x += 1) {
    const pixel = y * info.width + x
    if (Math.abs(gray[pixel] - gray[pixel - 1]) > 18 || Math.abs(gray[pixel] - gray[pixel - info.width]) > 18) edgeCount += 1
    comparisons += 1
  }
  let symmetryError = 0, symmetrySamples = 0
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width / 2; x += 1) {
    symmetryError += Math.abs(mask[y * info.width + x] - mask[y * info.width + (info.width - 1 - x)])
    symmetrySamples += 1
  }
  const mean = graySum / gray.length
  const deviation = Math.sqrt(Math.max(0, graySquared / gray.length - mean * mean))
  return {
    view: frame.view,
    heightToWidth: foregroundCount ? (maxY - minY + 1) / (maxX - minX + 1) * frame.height / frame.width : null,
    occupancy: foregroundCount / mask.length,
    contrast: clamp(deviation / 64),
    edgeDensity: edgeCount / Math.max(1, comparisons),
    symmetry: 1 - symmetryError / Math.max(1, symmetrySamples),
    clippingRisk: borderForeground / Math.max(1, foregroundCount)
  }
}

function decodeCapture(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Visual review capture must be a PNG data URL')
  const buffer = Buffer.from(match[1], 'base64')
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('Visual review capture size is invalid')
  return buffer
}

function cornerColor(data: Buffer, width: number, height: number, channels: number): [number, number, number] {
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  return [0, 1, 2].map((channel) => Math.round(points.reduce((sum, [x, y]) => sum + data[(y * width + x) * channels + channel], 0) / points.length)) as [number, number, number]
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function consistency(values: number[]): number {
  const mean = average(values)
  const deviation = Math.sqrt(average(values.map((value) => (value - mean) ** 2)))
  return clamp(1 - deviation / Math.max(0.05, mean))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}
