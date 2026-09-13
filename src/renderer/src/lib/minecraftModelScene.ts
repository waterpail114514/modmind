import * as THREE from 'three'
import type { FtbQuestIconResult } from '../../../shared/types'

export type MinecraftModelPreview = NonNullable<FtbQuestIconResult['modelPreview']>
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const vector = (value: unknown, fallback: number[]): number[] => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback
const radians = (value: number): number => value * Math.PI / 180

/** Shared by FTB thumbnails and the interactive resource preview. */
export async function createMinecraftModel(preview: MinecraftModelPreview): Promise<{ group: THREE.Group; dispose: () => void }> {
  const group = new THREE.Group()
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = []
  const textures = new Map<string, THREE.Texture>()
  const dispose = (): void => { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()) }
  const loader = new THREE.TextureLoader()
  try {
    for (const [key, url] of Object.entries(preview.textures)) {
      const texture = await loader.loadAsync(url)
      texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace
      textures.set(key, texture)
    }
    for (const raw of preview.elements) {
      const element = record(raw), from = vector(element.from, [0, 0, 0]), to = vector(element.to, [16, 16, 16])
      const [x0,y0,z0] = from, [x1,y1,z1] = to
      const faces: Record<string, { points: number[][]; uv: number[]; light: number }> = {
        south: { points: [[x0,y1,z1],[x1,y1,z1],[x1,y0,z1],[x0,y0,z1]], uv: [x0,16-y1,x1,16-y0], light: .8 },
        north: { points: [[x1,y1,z0],[x0,y1,z0],[x0,y0,z0],[x1,y0,z0]], uv: [16-x1,16-y1,16-x0,16-y0], light: .8 },
        east: { points: [[x1,y1,z1],[x1,y1,z0],[x1,y0,z0],[x1,y0,z1]], uv: [16-z1,16-y1,16-z0,16-y0], light: .6 },
        west: { points: [[x0,y1,z0],[x0,y1,z1],[x0,y0,z1],[x0,y0,z0]], uv: [z0,16-y1,z1,16-y0], light: .6 },
        up: { points: [[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]], uv: [x0,z0,x1,z1], light: 1 },
        down: { points: [[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]], uv: [x0,16-z1,x1,16-z0], light: .5 }
      }
      const elementGroup = new THREE.Group()
      for (const [name, rawFace] of Object.entries(record(element.faces))) {
        const face = record(rawFace), definition = faces[name], texture = textures.get(face.texture)
        if (!definition || !texture) continue
        const uv = Array.isArray(face.uv) && face.uv.length === 4 ? face.uv : definition.uv
        const corners = [[uv[0]/16,1-uv[1]/16],[uv[2]/16,1-uv[1]/16],[uv[2]/16,1-uv[3]/16],[uv[0]/16,1-uv[3]/16]]
        const turn = ((Math.round((Number(face.rotation) || 0) / 90) % 4) + 4) % 4
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(definition.points.flat(), 3))
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(corners.flatMap((_, i) => corners[(i + turn) % 4]), 2))
        geometry.setIndex([0,2,1,0,3,2]); geometry.computeVertexNormals(); geometries.push(geometry)
        const shade = element.shade === false ? 1 : definition.light
        const color = new THREE.Color(shade, shade, shade)
        if (typeof face.tintindex === 'number' && face.tintindex >= 0) color.multiply(new THREE.Color(0x91bd59))
        const material = new THREE.MeshBasicMaterial({ map: texture, color, alphaTest: .1, side: THREE.DoubleSide })
        materials.push(material); elementGroup.add(new THREE.Mesh(geometry, material))
      }
      const rotation = record(element.rotation)
      if (rotation.axis && typeof rotation.angle === 'number') {
        const origin = vector(rotation.origin, [8,8,8]), axis = ['x','y','z'].indexOf(rotation.axis)
        if (axis >= 0) {
          const pivot = new THREE.Group(); pivot.position.set(...origin as [number,number,number])
          elementGroup.position.set(-origin[0],-origin[1],-origin[2]); pivot.add(elementGroup)
          pivot.rotation.set(axis===0?radians(rotation.angle):0,axis===1?radians(rotation.angle):0,axis===2?radians(rotation.angle):0)
          if (rotation.rescale) { const scale = 1/Math.cos(radians(rotation.angle)); pivot.scale.set(axis===0?1:scale,axis===1?1:scale,axis===2?1:scale) }
          group.add(pivot)
        } else group.add(elementGroup)
      } else group.add(elementGroup)
    }
    return { group, dispose }
  } catch (error) { dispose(); throw error }
}
