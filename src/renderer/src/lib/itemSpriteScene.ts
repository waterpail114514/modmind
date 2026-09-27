import * as THREE from 'three'

const spriteSize = 16
const spriteDepth = 1
const alphaCutoff = 26
const maxOutlineSize = 128

/** Shared world-space UVs keep the two caps aligned, including asymmetric cutouts. */
export function itemSpriteGeometry(pixels: Uint8ClampedArray, width: number, height: number): THREE.BufferGeometry {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > maxOutlineSize || height > maxOutlineSize || pixels.length !== width * height * 4) throw new Error('物品贴图像素无效')
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = []
  const z0 = (spriteSize - spriteDepth) / 2, z1 = z0 + spriteDepth
  const solid = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4 + 3] >= alphaCutoff
  const quad = (points: number[][], uv: number[][], shade = 1): void => {
    const offset = positions.length / 3
    positions.push(...points.flat()); uvs.push(...uv.flat())
    for (let i = 0; i < 4; i++) colors.push(shade, shade, shade)
    indices.push(offset, offset + 2, offset + 1, offset, offset + 3, offset + 2)
  }
  quad([[0,16,z1],[16,16,z1],[16,0,z1],[0,0,z1]], [[0,1],[1,1],[1,0],[0,0]])
  quad([[16,16,z0],[0,16,z0],[0,0,z0],[16,0,z0]], [[1,1],[0,1],[0,0],[1,0]])
  let opaquePixels = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!solid(x, y)) continue
    opaquePixels++
    const x0 = x * spriteSize / width, x1 = (x + 1) * spriteSize / width
    const y0 = spriteSize - (y + 1) * spriteSize / height, y1 = spriteSize - y * spriteSize / height
    // Sample the edge pixel's center so the narrow side cannot bleed into transparency.
    const uv = Array.from({ length: 4 }, () => [(x + .5) / width, 1 - (y + .5) / height])
    if (!solid(x - 1, y)) quad([[x0,y1,z0],[x0,y1,z1],[x0,y0,z1],[x0,y0,z0]], uv, .75)
    if (!solid(x + 1, y)) quad([[x1,y1,z1],[x1,y1,z0],[x1,y0,z0],[x1,y0,z1]], uv, .75)
    if (!solid(x, y - 1)) quad([[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]], uv, .9)
    if (!solid(x, y + 1)) quad([[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]], uv, .6)
  }
  if (!opaquePixels) throw new Error('物品贴图没有可显示的像素')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export async function createItemSpriteScene(dataUrl: string): Promise<{ group: THREE.Group; dispose: () => void }> {
  const texture = await new THREE.TextureLoader().loadAsync(dataUrl)
  let geometry: THREE.BufferGeometry | undefined, material: THREE.MeshBasicMaterial | undefined
  const dispose = (): void => { geometry?.dispose(); material?.dispose(); texture.dispose() }
  try {
    const image = texture.image as HTMLImageElement
    const scale = Math.min(1, maxOutlineSize / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('物品贴图无法读取')
    context.imageSmoothingEnabled = false
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    geometry = itemSpriteGeometry(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false
    material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: .1, side: THREE.FrontSide })
    const group = new THREE.Group()
    group.add(new THREE.Mesh(geometry, material))
    return { group, dispose }
  } catch (error) { dispose(); throw error }
}
