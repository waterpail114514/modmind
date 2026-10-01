import {describe, expect, it} from 'vitest'
import type {BlockbenchProjectState} from '../shared/blockbench'
import {describeBlockbenchActions, diffBlockbenchProjects} from "../../feature-plugins/model-studio/src/main/blockbenchDiff"

function state(): BlockbenchProjectState {
  return {
    revision: `sha256:${'a'.repeat(64)}`, project: {uuid: 'p', name: 'Model', saved: false, textureWidth: 16, textureHeight: 16},
    format: {id: 'free', name: 'Free'}, counts: {cubes: 1, groups: 0, meshes: 0, textures: 0, animations: 0},
    cubes: [{kind: 'cube', uuid: 'cube', name: 'body', from: [0, 0, 0], to: [2, 2, 2], origin: [0, 0, 0], rotation: [0, 0, 0], inflate: 0, visibility: true, boxUv: false, faces: {
      north: {enabled: true}, east: {enabled: true}, south: {enabled: true}, west: {enabled: true}, up: {enabled: true}, down: {enabled: true}
    }}], groups: [], meshes: [], textures: [], animations: [], selection: []
  }
}

describe('Blockbench structural diff', () => {
  it('reports added, removed, and field-level changed editable objects', () => {
    const before = state()
    const after = state()
    after.revision = `sha256:${'b'.repeat(64)}`
    after.cubes[0] = {...after.cubes[0], inflate: 1}
    after.groups.push({kind: 'group', uuid: 'group', name: 'root', origin: [0, 0, 0], rotation: [0, 0, 0], visibility: true, children: []})
    const diff = diffBlockbenchProjects(before, after)
    expect(diff.counts).toEqual({added: 1, removed: 0, changed: 1})
    expect(diff.entries).toContainEqual(expect.objectContaining({category: 'cube', change: 'changed', fields: ['inflate']}))
    expect(diff.entries).toContainEqual(expect.objectContaining({category: 'group', change: 'added'}))
  })

  it('describes action batches without embedding large payloads', () => {
    expect(describeBlockbenchActions([{type: 'add-mesh', name: 'mesh', vertices: {a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0]}, faces: [{vertices: ['a', 'b', 'c']}]}]))
      .toEqual([{type: 'add-mesh', target: 'mesh', detail: '3 vertices, 1 faces'}])
  })
})
