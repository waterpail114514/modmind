import sharp from 'sharp'
import type { PerfectPixelOptions, PerfectPixelSampleMethod } from '../../../../src/shared/imageStudio'

// Adapted from the MIT-licensed perfect-pixel project: https://github.com/theamusing/perfectPixel
interface RgbImage {
  data: Uint8Array
  width: number
  height: number
}

interface GridResult {
  width: number
  height: number
  data: Uint8Array
}

const SAMPLE_METHODS: PerfectPixelSampleMethod[] = ['majority', 'center', 'median']

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function reflectIndex(value: number, length: number): number {
  if (length <= 1) return 0
  let index = value
  while (index < 0 || index >= length) index = index < 0 ? -index - 1 : length * 2 - index - 1
  return index
}

function rgbToGray(image: RgbImage): Float32Array {
  const gray = new Float32Array(image.width * image.height)
  for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 3) {
    gray[pixel] = 0.299 * image.data[offset] + 0.587 * image.data[offset + 1] + 0.114 * image.data[offset + 2]
  }
  return gray
}

function sobel(gray: Float32Array, width: number, height: number): { x: Float32Array; y: Float32Array } {
  const gx = new Float32Array(width * height)
  const gy = new Float32Array(width * height)
  const kernelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
  const kernelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumX = 0
      let sumY = 0
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const sample = gray[reflectIndex(y + ky, height) * width + reflectIndex(x + kx, width)]
          const kernelIndex = (ky + 1) * 3 + kx + 1
          sumX += sample * kernelX[kernelIndex]
          sumY += sample * kernelY[kernelIndex]
        }
      }
      const index = y * width + x
      gx[index] = sumX
      gy[index] = sumY
    }
  }
  return { x: gx, y: gy }
}

function axisGradient(gradient: Float32Array, width: number, height: number, axis: 'x' | 'y'): Float32Array {
  const result = new Float32Array(axis === 'x' ? width : height)
  if (axis === 'x') {
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) result[x] += Math.abs(gradient[y * width + x])
  } else {
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) result[y] += Math.abs(gradient[y * width + x])
  }
  return result
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function detectGridCount(projection: Float32Array, dimension: number, minSize: number, peakWidth: number): number | null {
  let maximum = 0
  for (const value of projection) maximum = Math.max(maximum, value)
  if (maximum <= 1e-6) return null
  const threshold = maximum * 0.2
  const peaks: number[] = []
  const minDistance = Math.max(2, Math.round(peakWidth))
  for (let index = 1; index < projection.length - 1; index += 1) {
    if (projection[index] < threshold || projection[index] < projection[index - 1] || projection[index] < projection[index + 1] || (projection[index] === projection[index - 1] && projection[index] === projection[index + 1])) continue
    if (!peaks.length || index - peaks[peaks.length - 1] >= minDistance) peaks.push(index)
  }
  if (peaks.length < 4) return null
  const intervals: number[] = []
  for (let index = 1; index < peaks.length; index += 1) intervals.push(peaks[index] - peaks[index - 1])
  const interval = median(intervals)
  if (!Number.isFinite(interval) || interval < Math.max(1, minSize)) return null
  return clamp(Math.round(dimension / interval), 1, dimension)
}

function autoGrid(image: RgbImage, minSize: number, peakWidth: number): [number, number] {
  const gradients = sobel(rgbToGray(image), image.width, image.height)
  const xCount = detectGridCount(axisGradient(gradients.x, image.width, image.height, 'x'), image.width, minSize, peakWidth)
  const yCount = detectGridCount(axisGradient(gradients.y, image.width, image.height, 'y'), image.height, minSize, peakWidth)
  if (xCount && yCount) {
    const xSize = image.width / xCount
    const ySize = image.height / yCount
    const pixelSize = xSize / ySize > 1.5 || ySize / xSize > 1.5 ? Math.min(xSize, ySize) : (xSize + ySize) / 2
    return [clamp(Math.round(image.width / pixelSize), 1, image.width), clamp(Math.round(image.height / pixelSize), 1, image.height)]
  }

  // A deterministic fallback keeps the embedded implementation useful for flat images
  // where no meaningful edge peaks exist. It is intentionally bounded by the library's
  // documented minimum pixel size instead of silently returning the original image.
  const fallbackCell = clamp(Math.round(Math.min(image.width, image.height) / 32), Math.max(1, Math.round(minSize)), 20)
  return [Math.max(1, Math.round(image.width / fallbackCell)), Math.max(1, Math.round(image.height / fallbackCell))]
}

function findBestGrid(origin: number, range: number, projection: Float32Array): number {
  const baseline = Math.round(origin)
  let best = baseline
  let bestValue = -Infinity
  for (let offset = -Math.round(range); offset <= Math.round(range); offset += 1) {
    const candidate = Math.round(origin + offset)
    if (candidate <= 0 || candidate >= projection.length - 1) continue
    if (projection[candidate] > projection[candidate - 1] && projection[candidate] > projection[candidate + 1] && projection[candidate] > bestValue) {
      bestValue = projection[candidate]
      best = candidate
    }
  }
  return best
}

function refineGrids(image: RgbImage, gridWidth: number, gridHeight: number, intensity: number): { x: number[]; y: number[] } {
  const gradients = sobel(rgbToGray(image), image.width, image.height)
  const xProjection = axisGradient(gradients.x, image.width, image.height, 'x')
  const yProjection = axisGradient(gradients.y, image.width, image.height, 'y')
  const cellWidth = image.width / Math.max(1, gridWidth)
  const cellHeight = image.height / Math.max(1, gridHeight)
  const xCoords: number[] = []
  const yCoords: number[] = []
  const refineX = cellWidth * clamp(intensity, 0, 0.5)
  const refineY = cellHeight * clamp(intensity, 0, 0.5)

  const buildAxis = (dimension: number, count: number, cell: number, range: number, projection: Float32Array): number[] => {
    const anchor = findBestGrid(dimension / 2, cell, projection)
    const start = anchor - (count / 2) * cell
    const coords: number[] = []
    for (let index = 0; index <= count; index += 1) {
      const ideal = start + index * cell
      const refined = index === 0 ? 0 : index === count ? dimension : findBestGrid(ideal, range, projection)
      const previous = coords[index - 1]
      coords.push(Math.max(previous === undefined ? 0 : previous + 1, clamp(refined, 0, dimension)))
    }
    coords[0] = 0
    coords[coords.length - 1] = dimension
    return coords
  }
  xCoords.push(...buildAxis(image.width, Math.max(1, gridWidth), cellWidth, refineX, xProjection))
  yCoords.push(...buildAxis(image.height, Math.max(1, gridHeight), cellHeight, refineY, yProjection))
  return { x: xCoords, y: yCoords }
}

function sampleCenter(image: RgbImage, xCoords: number[], yCoords: number[]): GridResult {
  const width = Math.max(1, xCoords.length - 1)
  const height = Math.max(1, yCoords.length - 1)
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const centerY = clamp(Math.floor((yCoords[y] + yCoords[y + 1]) / 2), 0, image.height - 1)
    for (let x = 0; x < width; x += 1) {
      const centerX = clamp(Math.floor((xCoords[x] + xCoords[x + 1]) / 2), 0, image.width - 1)
      const source = (centerY * image.width + centerX) * 3
      const target = (y * width + x) * 3
      data[target] = image.data[source]
      data[target + 1] = image.data[source + 1]
      data[target + 2] = image.data[source + 2]
    }
  }
  return { width, height, data }
}

function sampleMedian(image: RgbImage, xCoords: number[], yCoords: number[]): GridResult {
  const width = Math.max(1, xCoords.length - 1)
  const height = Math.max(1, yCoords.length - 1)
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const y0 = clamp(Math.floor(yCoords[y]), 0, image.height - 1)
    const y1 = clamp(Math.max(y0 + 1, Math.ceil(yCoords[y + 1])), 1, image.height)
    for (let x = 0; x < width; x += 1) {
      const x0 = clamp(Math.floor(xCoords[x]), 0, image.width - 1)
      const x1 = clamp(Math.max(x0 + 1, Math.ceil(xCoords[x + 1])), 1, image.width)
      const channels: number[][] = [[], [], []]
      for (let row = y0; row < y1; row += 1) for (let column = x0; column < x1; column += 1) {
        const source = (row * image.width + column) * 3
        channels[0].push(image.data[source]); channels[1].push(image.data[source + 1]); channels[2].push(image.data[source + 2])
      }
      const target = (y * width + x) * 3
      data[target] = Math.round(median(channels[0])); data[target + 1] = Math.round(median(channels[1])); data[target + 2] = Math.round(median(channels[2]))
    }
  }
  return { width, height, data }
}

function sampleMajority(image: RgbImage, xCoords: number[], yCoords: number[]): GridResult {
  const width = Math.max(1, xCoords.length - 1)
  const height = Math.max(1, yCoords.length - 1)
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const y0 = clamp(Math.floor(yCoords[y]), 0, image.height - 1)
    const y1 = clamp(Math.max(y0 + 1, Math.ceil(yCoords[y + 1])), 1, image.height)
    for (let x = 0; x < width; x += 1) {
      const x0 = clamp(Math.floor(xCoords[x]), 0, image.width - 1)
      const x1 = clamp(Math.max(x0 + 1, Math.ceil(xCoords[x + 1])), 1, image.width)
      const pixels: number[][] = []
      const total = (y1 - y0) * (x1 - x0)
      const stride = Math.max(1, Math.ceil(total / 128))
      let ordinal = 0
      for (let row = y0; row < y1; row += 1) for (let column = x0; column < x1; column += 1, ordinal += 1) {
        if (ordinal % stride !== 0) continue
        const source = (row * image.width + column) * 3
        pixels.push([image.data[source], image.data[source + 1], image.data[source + 2]])
      }
      const first = pixels[0] || [0, 0, 0]
      let second = first
      let furthest = -1
      for (const pixel of pixels) {
        const distance = (pixel[0] - first[0]) ** 2 + (pixel[1] - first[1]) ** 2 + (pixel[2] - first[2]) ** 2
        if (distance > furthest) { furthest = distance; second = pixel }
      }
      let groupA = pixels
      let groupB: number[][] = []
      for (let iteration = 0; iteration < 4 && pixels.length > 1; iteration += 1) {
        groupA = []; groupB = []
        for (const pixel of pixels) {
          const distanceA = (pixel[0] - first[0]) ** 2 + (pixel[1] - first[1]) ** 2 + (pixel[2] - first[2]) ** 2
          const distanceB = (pixel[0] - second[0]) ** 2 + (pixel[1] - second[1]) ** 2 + (pixel[2] - second[2]) ** 2
          ;(distanceB < distanceA ? groupB : groupA).push(pixel)
        }
        if (groupA.length) for (let channel = 0; channel < 3; channel += 1) first[channel] = groupA.reduce((sum, pixel) => sum + pixel[channel], 0) / groupA.length
        if (groupB.length) for (let channel = 0; channel < 3; channel += 1) second[channel] = groupB.reduce((sum, pixel) => sum + pixel[channel], 0) / groupB.length
      }
      const chosen = groupB.length >= groupA.length ? second : first
      const target = (y * width + x) * 3
      data[target] = clamp(Math.round(chosen[0]), 0, 255); data[target + 1] = clamp(Math.round(chosen[1]), 0, 255); data[target + 2] = clamp(Math.round(chosen[2]), 0, 255)
    }
  }
  return { width, height, data }
}

function fixSquare(result: GridResult): GridResult {
  if (Math.abs(result.width - result.height) !== 1) return result
  if (result.width > result.height) {
    if (result.width % 2 === 1) {
      const data = new Uint8Array((result.width - 1) * result.height * 3)
      for (let y = 0; y < result.height; y += 1) data.set(result.data.subarray(y * result.width * 3, y * result.width * 3 + (result.width - 1) * 3), y * (result.width - 1) * 3)
      return { width: result.width - 1, height: result.height, data }
    }
    const data = new Uint8Array(result.width * (result.height + 1) * 3)
    data.set(result.data.subarray(0, result.width * 3), 0)
    data.set(result.data, result.width * 3)
    return { width: result.width, height: result.height + 1, data }
  }
  if (result.height % 2 === 1) {
    const data = new Uint8Array(result.width * (result.height - 1) * 3)
    data.set(result.data.subarray(0, data.length), 0)
    return { width: result.width, height: result.height - 1, data }
  }
  const data = new Uint8Array((result.width + 1) * result.height * 3)
  for (let y = 0; y < result.height; y += 1) {
    const source = result.data.subarray(y * result.width * 3, (y + 1) * result.width * 3)
    const target = y * (result.width + 1) * 3
    data.set(source.subarray(0, 3), target)
    data.set(source, target + 3)
  }
  return { width: result.width + 1, height: result.height, data }
}

export async function runEmbeddedPerfectPixel(source: Buffer, options?: PerfectPixelOptions): Promise<Buffer> {
  const raw = await sharp(source).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const image: RgbImage = { data: raw.data, width: raw.info.width, height: raw.info.height }
  const sampleMethod = SAMPLE_METHODS.includes(options?.sampleMethod as PerfectPixelSampleMethod) ? options!.sampleMethod! : 'center'
  const minSize = Number.isFinite(options?.minSize) ? clamp(options!.minSize!, 0.1, 1_000) : 4
  const peakWidth = Number.isFinite(options?.peakWidth) ? clamp(options!.peakWidth!, 1, 1_000) : 6
  const gridSize = Array.isArray(options?.gridSize) && options.gridSize.length === 2 && options.gridSize.every((value) => Number.isFinite(value) && value > 0)
    ? [clamp(Math.round(options.gridSize[0]), 1, image.width), clamp(Math.round(options.gridSize[1]), 1, image.height)] as [number, number]
    : autoGrid(image, minSize, peakWidth)
  const intensity = Number.isFinite(options?.refineIntensity) ? clamp(options!.refineIntensity!, 0, 0.5) : 0.3
  const grids = refineGrids(image, gridSize[0], gridSize[1], intensity)
  let result = sampleMethod === 'majority' ? sampleMajority(image, grids.x, grids.y) : sampleMethod === 'median' ? sampleMedian(image, grids.x, grids.y) : sampleCenter(image, grids.x, grids.y)
  if (options?.fixSquare !== false) result = fixSquare(result)
  return sharp(result.data, { raw: { width: result.width, height: result.height, channels: 3 } }).png().toBuffer()
}
