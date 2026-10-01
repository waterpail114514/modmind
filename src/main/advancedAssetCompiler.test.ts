import {describe, expect, it} from 'vitest'
import type {AdvancedAssetProgram} from '../shared/advancedAsset'
import {compileAdvancedAsset, compileAdvancedAssetVariants, optimizeAdvancedProgram} from "../../feature-plugins/model-studio/src/main/advancedAssetCompiler"
import {validateAction} from "../../feature-plugins/model-studio/src/main/blockbenchBridge"

const advancedProgram: AdvancedAssetProgram = {
  version: 1,
  metadata: {name: 'Kinetic Staff', quality: 'hero', symmetry: 'bilateral'},
  model: {
    format: 'free', textureWidth: 64, textureHeight: 64,
    primitives: [
      {id: 'core', type: 'cube', size: [4, 8, 4], center: [0, 4, 0]},
      {id: 'guard', type: 'wedge', size: [10, 3, 4], center: [0, 9, 0], parent: 'core'},
      {id: 'collar', type: 'cylinder', radius: 3, height: 3, segments: 10, center: [0, 11, 0]},
      {id: 'orb', type: 'sphere', radius: 3, segments: 10, rings: 6, center: [0, 15, 0]},
      {id: 'blade', type: 'extrude', profile: [[-2, 0], [0, 7], [2, 0]], depth: 1.5, center: [0, 20, 0]},
      {id: 'arc', type: 'tube', path: [[0, 13, 0], [5, 16, 0], [4, 22, 2]], radius: 0.5, radialSegments: 6, curveSegments: 3}
    ]
  },
  texture: {fill: '#26313aff', rectangles: [{x: 0, y: 0, width: 8, height: 8, color: '#d3a63fff'}]},
  rig: {
    name: 'staff_rig', bones: [{id: 'root'}, {id: 'tip', parent: 'root', origin: [0, 14, 0]}],
    weightRules: [{mesh: 'arc', lowerBone: 'root', upperBone: 'tip', axis: 1, split: 16, blend: 4}],
    locators: [{id: 'effect_socket', position: [0, 22, 0], parent: 'tip'}],
    ik: [{id: 'tip_ik', position: [0, 24, 0], target: 'tip', source: 'root'}]
  },
  animations: [{name: 'pulse', length: 1, loop: 'loop', tracks: [{target: 'tip', channel: 'rotation', keyframes: [
    {time: 0, value: [0, 0, 0]}, {time: 0.5, value: [0, 0, 15]}, {time: 1, value: [0, 0, 0]}
  ]}]}],
  variants: [{id: 'compact', label: 'Compact', scale: 0.85}, {id: 'gold', label: 'Gold', accent: '#ffe080ff'}]
}

describe('advanced editable asset compiler', () => {
  it('compiles curved mesh topology, UV, rigging, IK, and animation deterministically', () => {
    const first = compileAdvancedAsset(advancedProgram)
    const second = compileAdvancedAsset(advancedProgram)
    expect(first).toEqual(second)
    expect(first.diagnostics).toEqual([])
    expect(first.summary).toMatchObject({primitives: 6, cubes: 1, meshes: 5, bones: 2, animations: 1})
    expect(first.summary.vertices).toBeGreaterThan(100)
    expect(first.actions.map(validateAction)).toEqual(first.actions)
    expect(first.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'add-mesh', name: 'arc_mesh'}),
      expect.objectContaining({type: 'auto-unwrap-mesh', meshName: 'arc_mesh'}),
      expect.objectContaining({type: 'set-vertex-weights', meshName: 'arc_mesh'}),
      expect.objectContaining({type: 'add-ik-target', name: 'tip_ik'}),
      expect.objectContaining({type: 'add-keyframe', groupName: 'tip'})
    ]))
  })

  it('produces independently replayable A/B/C variants', () => {
    const candidates = compileAdvancedAssetVariants(advancedProgram)
    expect(candidates.map((candidate) => candidate.variantId)).toEqual(['base', 'compact', 'gold'])
    expect(new Set(candidates.map((candidate) => candidate.programHash)).size).toBe(3)
    expect(candidates.every((candidate) => candidate.actions[0]?.type === 'new-model')).toBe(true)
  })

  it('builds bounded optimizer mutations without changing the source program', () => {
    const larger = optimizeAdvancedProgram(advancedProgram, 'occupancy-up')
    const contrast = optimizeAdvancedProgram(advancedProgram, 'contrast')
    expect((larger.model.primitives[0] as {size: number[]}).size[0]).toBeCloseTo(4.48)
    expect(contrast.texture?.fill).toBe('#30343aff')
    expect(advancedProgram.texture?.fill).toBe('#26313aff')
  })

  it('rejects unknown hierarchy and rig references before emitting mutations', () => {
    const candidate = compileAdvancedAsset({...advancedProgram, model: {...advancedProgram.model, primitives: [
      {id: 'mesh', type: 'cylinder', radius: 2, height: 4, parent: 'missing'}
    ]}})
    expect(candidate.actions).toEqual([])
    expect(candidate.diagnostics).toContainEqual(expect.objectContaining({message: expect.stringContaining('Unknown primitive or bone parent')}))
  })
})
