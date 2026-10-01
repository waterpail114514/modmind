import sharp from 'sharp'
import {describe, expect, it} from 'vitest'
import {validateAction} from "../../feature-plugins/model-studio/src/main/blockbenchBridge"
import {analyzeReferenceImage, compileReferenceImageAsset} from "../../feature-plugins/model-studio/src/main/referenceImageAssetCompiler"

async function referencePng(): Promise<Buffer> {
  return sharp({create: {width: 64, height: 64, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
    .composite([
      {input: Buffer.from('<svg width="32" height="48"><path d="M16 0 L30 18 L24 46 L8 46 L2 18 Z" fill="#d08030"/></svg>'), left: 16, top: 8}
    ]).png().toBuffer()
}

describe('reference image editable asset compiler', () => {
  it('extracts alpha bounds, palette, silhouette, and an editable extruded mesh', async () => {
    const image = await referencePng()
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`
    const candidate = await compileReferenceImageAsset({
      version: 1, metadata: {name: 'Reference Blade'}, image: {dataUrl, depth: 2, maxProfilePoints: 32},
      model: {format: 'free', textureWidth: 64, textureHeight: 64}
    })
    expect(candidate.reference.alphaBounds).toMatchObject({left: 18, top: 8, right: 45})
    expect(candidate.reference.profilePoints.length).toBeGreaterThanOrEqual(8)
    expect(candidate.reference.dominantColors[0]).toMatch(/^#[0-9a-f]{8}$/)
    expect(candidate.actions.map(validateAction)).toEqual(candidate.actions)
    expect(candidate.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'create-texture', dataUrl: expect.stringMatching(/^data:image\/png;base64,/)}),
      expect.objectContaining({type: 'add-mesh', name: 'reference_profile_mesh'})
    ]))
    const mesh = candidate.actions.find((action) => action.type === 'add-mesh')
    expect(mesh && mesh.type === 'add-mesh' && mesh.faces.every((face) => Object.keys(face.uv ?? {}).length === face.vertices.length)).toBe(true)
  })

  it('segments an opaque image against its border color', async () => {
    const image = await sharp({create: {width: 40, height: 30, channels: 4, background: '#ffffff'}})
      .composite([{input: Buffer.from('<svg width="16" height="18"><rect width="16" height="18" fill="#202020"/></svg>'), left: 12, top: 6}])
      .png().toBuffer()
    const analysis = await analyzeReferenceImage(image)
    expect(analysis.alphaBounds).toEqual({left: 12, top: 6, right: 27, bottom: 23})
  })

  it('rejects unsupported or oversized reference payloads', async () => {
    await expect(compileReferenceImageAsset({version: 1, metadata: {name: 'bad'}, image: {dataUrl: 'data:text/plain;base64,QQ=='}}))
      .rejects.toThrow(/PNG, JPEG, or WebP/)
  })
})
