import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { runEmbeddedPerfectPixel } from '../../feature-plugins/image-studio/src/main/perfectPixel'

describe('embedded PerfectPixel', () => {
  it('refines an image using a supplied grid without Python', async () => {
    const width = 32
    const height = 32
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cellX = Math.floor(x / 8)
        const cellY = Math.floor(y / 8)
        const offset = (y * width + x) * 3
        data[offset] = cellX * 40
        data[offset + 1] = cellY * 40
        data[offset + 2] = 120
      }
    }

    const output = await runEmbeddedPerfectPixel(await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer(), {
      gridSize: [4, 4],
      sampleMethod: 'center',
      fixSquare: true
    })
    const result = await sharp(output).raw().toBuffer({ resolveWithObject: true })
    expect(result.info.width).toBe(4)
    expect(result.info.height).toBe(4)
    expect(Array.from(result.data.subarray(0, 3))).toEqual([0, 0, 120])
    expect(Array.from(result.data.subarray((3 * 4 + 3) * 3, (3 * 4 + 4) * 3))).toEqual([120, 120, 120])
  })

  it('auto-detects regular grid spacing from image edges', async () => {
    const width = 64
    const height = 64
    const data = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3
        data[offset] = Math.floor(x / 8) % 2 ? 240 : 20
        data[offset + 1] = Math.floor(y / 8) % 2 ? 240 : 20
        data[offset + 2] = 100
      }
    }
    const output = await runEmbeddedPerfectPixel(await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer())
    const result = await sharp(output).metadata()
    expect(result.width).toBe(8)
    expect(result.height).toBe(8)
  })
})
