import { expect, it } from 'vitest'
import * as THREE from 'three'
import { itemSpriteGeometry } from './itemSpriteScene'

function pixels(rows: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rows.flatMap(row => row.flatMap(alpha => [200, 100, 40, alpha])))
}

it('aligns front and rear UVs to the same silhouette without drawing inward faces', () => {
  const geometry = itemSpriteGeometry(pixels([[255, 0], [255, 255]]), 2, 2)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }))
  mesh.updateMatrixWorld()
  for (const [z, direction] of [[30, -1], [-30, 1]]) {
    const hits = new THREE.Raycaster(new THREE.Vector3(4, 10, z), new THREE.Vector3(0, 0, direction)).intersectObject(mesh)
    expect(hits).toHaveLength(1)
    expect(hits[0].uv?.toArray()).toEqual([.25, .625])
    expect(hits[0].face?.normal.z).toBe(-direction)
  }
  geometry.computeBoundingBox()
  expect(geometry.boundingBox!.getSize(new THREE.Vector3()).toArray()).toEqual([16, 16, 1])
  geometry.dispose(); (mesh.material as THREE.Material).dispose()
})

it('closes exposed pixel edges and holes without adding walls between solid pixels', () => {
  const solid = itemSpriteGeometry(pixels([[255, 255, 255], [255, 255, 255], [255, 255, 255]]), 3, 3)
  const ring = itemSpriteGeometry(pixels([[255, 255, 255], [255, 0, 255], [255, 255, 255]]), 3, 3)
  // Two caps plus the 12 outer pixel edges; the hole contributes four inner walls.
  expect(solid.index!.count / 6).toBe(14)
  expect(ring.index!.count / 6).toBe(18)
  for (const geometry of [solid, ring]) {
    const uv = geometry.getAttribute('uv')
    for (let i = 8; i < uv.count; i += 4) {
      const sample = [uv.getX(i), uv.getY(i)]
      for (let j = 1; j < 4; j++) expect([uv.getX(i + j), uv.getY(i + j)]).toEqual(sample)
    }
    geometry.dispose()
  }
})

it('rejects empty sprites and bounds outline work for large textures', () => {
  expect(() => itemSpriteGeometry(pixels([[0]]), 1, 1)).toThrow('没有可显示')
  expect(() => itemSpriteGeometry(new Uint8ClampedArray(129 * 129 * 4), 129, 129)).toThrow('像素无效')
})
