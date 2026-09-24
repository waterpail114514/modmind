import { expect, it } from 'vitest'
import * as THREE from 'three'
import { createProjectModelScene } from './projectModelScene'
import type { ProjectModelPreview } from '../../../shared/projectModels'

const preview = (elements: Record<string, unknown>[], outliner: unknown[] = []): ProjectModelPreview => ({ path: 'test.bbmodel', name: 'test', warnings: [], blockbench: { elements, outliner, textures: {}, resolution: { width: 16, height: 16 } } })
it('keeps absolute cube coordinates and rotates groups about their Blockbench pivot', async () => {
  const { group, dispose } = await createProjectModelScene(preview([{ uuid: 'cube', from: [11,0,0], to: [13,2,2] }], [{ origin: [10,0,0], rotation: [0,0,90], children: ['cube'] }]))
  const bounds = new THREE.Box3().setFromObject(group)
  expect(bounds.min.x).toBeCloseTo(8); expect(bounds.min.y).toBeCloseTo(1)
  expect(bounds.max.x).toBeCloseTo(10); expect(bounds.max.y).toBeCloseTo(3)
  expect(bounds.max.z).toBeCloseTo(2)
  dispose()
})
it('renders mesh vertices in local coordinates with valid triangulation and UVs', async () => {
  const { group, dispose } = await createProjectModelScene(preview([{ uuid: 'mesh', type: 'mesh', origin: [4,0,0], vertices: { a: [0,0,0], b: [2,0,0], c: [0,2,0] }, faces: { front: { vertices: ['a','b','c'], uv: { a: [0,0], b: [16,0], c: [0,16] } } } }]))
  const bounds = new THREE.Box3().setFromObject(group)
  expect(bounds.min.toArray()).toEqual([4,0,0]); expect(bounds.max.toArray()).toEqual([6,2,0])
  const mesh = group.children[0].children[0] as THREE.Mesh
  expect(mesh.geometry.index?.count).toBe(3)
  expect(Array.from(mesh.geometry.getAttribute('uv').array)).toEqual([0,1,1,1,0,0])
  dispose()
})
it('omits disabled faces and hidden elements, and rejects deeply nested groups', async () => {
  const { group, dispose } = await createProjectModelScene(preview([{ uuid: 'hidden', visibility: false }, { uuid: 'cube', from: [0,0,0], to: [1,1,1], faces: { north: { texture: null } } }]))
  expect(group.children).toHaveLength(1); expect(group.children[0].children).toHaveLength(5); dispose()
  let child: unknown = 'cube'
  for (let i = 0; i < 70; i++) child = { children: [child] }
  await expect(createProjectModelScene(preview([], [child]))).rejects.toThrow('层级过深')
})
it('unfolds box UVs using the cube dimensions and saved texture offset', async () => {
  const { group, dispose } = await createProjectModelScene(preview([{ uuid: 'cube', box_uv: true, uv_offset: [1,2], from: [0,0,0], to: [4,6,2] }]))
  const north = group.children[0].children[1] as THREE.Mesh
  expect(Array.from(north.geometry.getAttribute('uv').array)).toEqual([3/16, 12/16, 7/16, 12/16, 7/16, 6/16, 3/16, 6/16])
  dispose()
})
