import * as THREE from 'three'
import type { ProjectModelPreview } from '../../../shared/projectModels'
import { createMinecraftModel } from './minecraftModelScene'

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const vector = (value: unknown): [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(v => Number.isFinite(v) && Math.abs(v) <= 1e6) ? value as [number, number, number] : [0, 0, 0]
const radians = (value: number): number => value * Math.PI / 180

export async function createProjectModelScene(preview: ProjectModelPreview): Promise<{ group: THREE.Group; dispose: () => void }> {
  if (preview.minecraft) return createMinecraftModel(preview.minecraft, true)
  const model = preview.blockbench
  if (!model) throw new Error('没有可预览的模型数据')
  const group = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = []
  const textures = new Map<string, THREE.Texture>(), loaded = new Map<string, THREE.Texture>()
  const dispose = (): void => { geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); loaded.forEach(value => value.dispose()) }
  try {
    const loader = new THREE.TextureLoader()
    for (const [id, dataUrl] of Object.entries(model.textures)) {
      if (!/^data:image\/png;base64,/.test(dataUrl)) continue
      let texture = loaded.get(dataUrl)
      if (!texture) {
        texture = await loader.loadAsync(dataUrl)
        texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace
        loaded.set(dataUrl, texture)
      }
      textures.set(id, texture)
    }
    const addFace = (parent: THREE.Group, points: number[][], uv: number[][], textureId: unknown): void => {
      if (points.length < 3 || points.length > 64 || !points.flat().every(Number.isFinite)) return
      const geometry = new THREE.BufferGeometry()
      geometries.push(geometry)
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2))
      // Project onto the dominant plane for concave mesh faces.
      const normal = new THREE.Vector3()
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length]
        normal.x += (p[1] - q[1]) * (p[2] + q[2]); normal.y += (p[2] - q[2]) * (p[0] + q[0]); normal.z += (p[0] - q[0]) * (p[1] + q[1])
      })
      const axis = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)].indexOf(Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)))
      const polygon = points.map(p => new THREE.Vector2(p[(axis + 1) % 3], p[(axis + 2) % 3]))
      geometry.setIndex(THREE.ShapeUtils.triangulateShape(polygon, []).flat()); geometry.computeVertexNormals()
      const material = new THREE.MeshLambertMaterial({ map: textures.get(String(textureId)) ?? null, color: textures.has(String(textureId)) ? 0xffffff : 0xaab6bd, alphaTest: .1, side: THREE.DoubleSide })
      materials.push(material); parent.add(new THREE.Mesh(geometry, material))
    }
    const elements = new Map(model.elements.map((element, index) => [String(element.uuid ?? index), element]))
    const visited = new Set<string>()
    const buildElement = (id: string, parent: THREE.Group, parentOrigin: number[]): void => {
      if (visited.has(id)) return
      visited.add(id)
      const element = elements.get(id)
      if (!element || element.visibility === false || !['cube', 'mesh', undefined].includes(element.type as string | undefined)) return
      const origin = vector(element.origin), rotation = vector(element.rotation), node = new THREE.Group()
      node.name = String(element.name ?? '')
      node.position.set(origin[0] - parentOrigin[0], origin[1] - parentOrigin[1], origin[2] - parentOrigin[2])
      node.rotation.set(...rotation.map(radians) as [number, number, number], 'ZYX'); parent.add(node)
      if (element.type === 'mesh') {
        const vertices = record(element.vertices)
        for (const raw of Object.values(record(element.faces))) {
          const face = record(raw), keys = Array.isArray(face.vertices) ? face.vertices : []
          if (face.texture === null || keys.some(key => !vertices[key])) continue
          addFace(node, keys.map(key => vector(vertices[key])), keys.map(key => {
            const point = record(face.uv)[key]
            return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) ? [point[0] / model.resolution.width, 1 - point[1] / model.resolution.height] : [0, 0]
          }), face.texture)
        }
      } else {
        const from = vector(element.from), to = vector(element.to), inflate = Number.isFinite(element.inflate) ? Number(element.inflate) : 0
        const boxUv = element.box_uv === true || element.box_uv === undefined && model.boxUv
        const [u, v] = Array.isArray(element.uv_offset) && element.uv_offset.length === 2 && element.uv_offset.every(Number.isFinite) ? element.uv_offset as number[] : [0, 0]
        const [dx, dy, dz] = to.map((value, index) => Math.abs(value - from[index]))
        const boxFaces: Record<string, number[]> = {
          west: [u, v+dz, u+dz, v+dz+dy], north: [u+dz, v+dz, u+dz+dx, v+dz+dy],
          east: [u+dz+dx, v+dz, u+2*dz+dx, v+dz+dy], south: [u+2*dz+dx, v+dz, u+2*dz+2*dx, v+dz+dy],
          up: [u+dz, v, u+dz+dx, v+dz], down: [u+dz+dx, v+dz, u+dz+2*dx, v]
        }
        const [x0,y0,z0] = from.map((v, i) => v - origin[i] - inflate), [x1,y1,z1] = to.map((v, i) => v - origin[i] + inflate)
        const definitions = {
          south: [[x0,y1,z1],[x1,y1,z1],[x1,y0,z1],[x0,y0,z1]], north: [[x1,y1,z0],[x0,y1,z0],[x0,y0,z0],[x1,y0,z0]],
          east: [[x1,y1,z1],[x1,y1,z0],[x1,y0,z0],[x1,y0,z1]], west: [[x0,y1,z0],[x0,y1,z1],[x0,y0,z1],[x0,y0,z0]],
          up: [[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]], down: [[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]]
        }
        for (const [name, points] of Object.entries(definitions)) {
          const face = record(record(element.faces)[name])
          if (face.texture === null) continue
          const boxName = element.mirror_uv && name === 'east' ? 'west' : element.mirror_uv && name === 'west' ? 'east' : name
          const rawUv = boxUv ? boxFaces[boxName] : Array.isArray(face.uv) && face.uv.length === 4 && face.uv.every(Number.isFinite) ? face.uv : [0,0,16,16]
          const uv = boxUv && element.mirror_uv ? [rawUv[2], rawUv[1], rawUv[0], rawUv[3]] : rawUv
          const corners = [[uv[0],uv[1]],[uv[2],uv[1]],[uv[2],uv[3]],[uv[0],uv[3]]].map(([u,v]) => [u / model.resolution.width, 1 - v / model.resolution.height])
          const turn = ((Math.round((Number(face.rotation) || 0) / 90) % 4) + 4) % 4
          addFace(node, points, corners.map((_, i) => corners[(i + turn) % 4]), face.texture ?? (boxUv ? '0' : undefined))
        }
      }
    }
    let groupCount = 0
    const walk = (entries: unknown[], parent: THREE.Group, parentOrigin: number[], depth = 0): void => {
      if (depth > 64) throw new Error('模型层级过深')
      for (const entry of entries) {
        if (typeof entry === 'string' || typeof entry === 'number') { buildElement(String(entry), parent, parentOrigin); continue }
        if (++groupCount > 8192) throw new Error('模型分组过多')
        const data = record(entry), origin = vector(data.origin), node = new THREE.Group()
        node.name = String(data.name ?? ''); node.visible = parent.visible && data.visibility !== false
        node.position.set(origin[0] - parentOrigin[0], origin[1] - parentOrigin[1], origin[2] - parentOrigin[2])
        node.rotation.set(...vector(data.rotation).map(radians) as [number, number, number], 'ZYX'); parent.add(node)
        walk(Array.isArray(data.children) ? data.children : [], node, origin, depth + 1)
      }
    }
    walk(model.outliner, group, [0,0,0])
    for (const id of elements.keys()) if (!visited.has(id)) buildElement(id, group, [0,0,0])
    return { group, dispose }
  } catch (error) { dispose(); throw error }
}
