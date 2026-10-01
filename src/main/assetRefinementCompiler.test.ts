import {describe, expect, it} from 'vitest'
import type {AssetRefinementProgram} from '../shared/assetIntent'
import type {BlockbenchCubeState, BlockbenchProjectState} from '../shared/blockbench'
import {compileAssetRefinement} from "../../feature-plugins/model-studio/src/main/assetRefinementCompiler"
import {validateAction} from "../../feature-plugins/model-studio/src/main/blockbenchBridge"

const faces: BlockbenchCubeState['faces'] = {
  north: {enabled: true, textureUuid: 'texture'},
  east: {enabled: true, textureUuid: 'texture'},
  south: {enabled: true, textureUuid: 'texture'},
  west: {enabled: true, textureUuid: 'texture'},
  up: {enabled: true, textureUuid: 'texture'},
  down: {enabled: true, textureUuid: 'texture'}
}

function projectState(): BlockbenchProjectState {
  return {
    revision: `sha256:${'a'.repeat(64)}`,
    project: {uuid: 'project', name: 'Ember Raven', saved: false, textureWidth: 64, textureHeight: 64},
    metadata: {source: 'GENERATED', intentHash: 'b'.repeat(64), generatedAt: '2026-08-24T00:00:00.000Z'},
    format: {id: 'modded_entity', name: 'Modded Entity'},
    counts: {cubes: 4, groups: 4, meshes: 0, textures: 1, animations: 1},
    groups: [
      {kind: 'group', uuid: 'body-group', name: 'body', origin: [0, 8, 0], rotation: [0, 0, 0], visibility: true, children: ['body-cube']},
      {kind: 'group', uuid: 'head-group', name: 'head', parentUuid: 'body-group', origin: [0, 17, -1], rotation: [0, 0, 0], visibility: true, children: ['head-cube']},
      {kind: 'group', uuid: 'wing-group', name: 'wing_left', parentUuid: 'body-group', origin: [6, 9, 0], rotation: [0, 0, 0], visibility: true, children: ['wing-cube']},
      {kind: 'group', uuid: 'tail-group', name: 'tail', parentUuid: 'body-group', origin: [0, 6, 7], rotation: [0, 0, 0], visibility: true, children: ['tail-cube']}
    ],
    cubes: [
      cube('body-cube', 'body_volume', 'body-group', [-4, 3, -3], [4, 13, 3], [0, 8, 0]),
      cube('head-cube', 'head_volume', 'head-group', [-3, 14, -4], [3, 20, 2], [0, 17, -1]),
      cube('wing-cube', 'wing_left_volume', 'wing-group', [5, 5.5, -4], [7, 12.5, 4], [6, 9, 0]),
      cube('tail-cube', 'tail_volume', 'tail-group', [-2, 4, 3], [2, 8, 11], [0, 6, 7])
    ],
    meshes: [],
    textures: [{uuid: 'texture', name: 'ember_raven_atlas', width: 64, height: 64, visible: true, saved: false, pixelHash: 'pixels'}],
    animations: [{uuid: 'idle-animation', name: 'idle', length: 1, loop: 'loop', snapping: 20, selected: false, contentHash: 'idle', animators: []}],
    selection: []
  }
}

function cube(
  uuid: string,
  name: string,
  parentUuid: string,
  from: BlockbenchCubeState['from'],
  to: BlockbenchCubeState['to'],
  origin: BlockbenchCubeState['origin']
): BlockbenchCubeState {
  return {kind: 'cube', uuid, name, parentUuid, from, to, origin, rotation: [0, 0, 0], inflate: 0, visibility: true, boxUv: true, faces}
}

const refinement: AssetRefinementProgram = {
  version: 1,
  metadata: {name: 'Ember Raven refinement', sourceIntentHash: 'b'.repeat(64)},
  parts: [
    {id: 'tail', size: [4, 4, 12]},
    {id: 'head', size: [5, 5, 5]}
  ],
  animation: {
    name: 'wing_flap_refined',
    length: 1,
    loop: 'loop',
    tracks: [{part: 'wing_left', channel: 'rotation', keyframes: [
      {time: 0, value: [0, 0, 0]},
      {time: 0.5, value: [18, 0, 0]},
      {time: 1, value: [0, 0, 0]}
    ]}]
  }
}

describe('Asset Refinement compiler', () => {
  it('compiles deterministic geometry, animation, and provenance actions', () => {
    const first = compileAssetRefinement(refinement, projectState())
    const second = compileAssetRefinement(refinement, projectState())

    expect(first.intentHash).toBe(second.intentHash)
    expect(first.actions).toEqual(second.actions)
    expect(first.diagnostics).toEqual([])
    expect(first.summary).toMatchObject({name: 'Ember Raven refinement', format: 'modded_entity', parts: 2, animations: 1})
    expect(first.actions).toContainEqual(expect.objectContaining({
      type: 'update-cube', cubeUuid: 'tail-cube', from: [-2, 4, 1], to: [2, 8, 13]
    }))
    expect(first.actions).toContainEqual(expect.objectContaining({
      type: 'update-cube', cubeUuid: 'head-cube', from: [-2.5, 14.5, -3.5], to: [2.5, 19.5, 1.5]
    }))
    expect(first.actions).toContainEqual(expect.objectContaining({type: 'add-animation', name: 'wing_flap_refined'}))
    expect(first.actions.filter((action) => action.type === 'add-keyframe')).toHaveLength(3)
    expect(first.actions.map((action) => validateAction(action))).toEqual(first.actions)
    expect(first.actions.at(-1)).toEqual({
      type: 'set-asset-metadata',
      metadata: {source: 'REFINED', intentHash: first.intentHash, refinedFrom: 'b'.repeat(64)}
    })
  })

  it('returns no actions for unknown groups, ambiguous groups, or a stale source hash', () => {
    const unknown = compileAssetRefinement({...refinement, parts: [{id: 'missing', size: [1, 1, 1]}], animation: undefined}, projectState())
    expect(unknown.actions).toEqual([])
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({message: 'Unknown Blockbench group: missing'}))

    const ambiguousState = projectState()
    ambiguousState.cubes.push(cube('tail-detail', 'tail_detail', 'tail-group', [-1, 5, 5], [1, 7, 7], [0, 6, 6]))
    const ambiguous = compileAssetRefinement({...refinement, parts: [{id: 'tail', size: [4, 4, 12]}], animation: undefined}, ambiguousState)
    expect(ambiguous.actions).toEqual([])
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({message: 'Refinement requires exactly one cube in group tail'}))

    const stale = compileAssetRefinement({...refinement, metadata: {...refinement.metadata, sourceIntentHash: 'c'.repeat(64)}}, projectState())
    expect(stale.actions).toEqual([])
    expect(stale.diagnostics).toContainEqual(expect.objectContaining({path: 'metadata.sourceIntentHash'}))
  })

  it('does not reposition geometry for inflate-only refinements and diagnoses unsafe keyframes', () => {
    const inflate = compileAssetRefinement({...refinement, parts: [{id: 'tail', inflate: 0.5}], animation: undefined}, projectState())
    expect(inflate.diagnostics).toEqual([])
    expect(inflate.actions[0]).toEqual({type: 'update-cube', cubeUuid: 'tail-cube', inflate: 0.5})

    const invalidAnimation = compileAssetRefinement({
      ...refinement,
      parts: [],
      animation: {...refinement.animation!, tracks: [{part: 'wing_left', channel: 'rotation', keyframes: [
        {time: 0.5, value: [2048, 0, 0]}, {time: 0.5, value: [0, 0, 0]}
      ]}]}
    }, projectState())
    expect(invalidAnimation.actions).toEqual([])
    expect(invalidAnimation.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      'Duplicate keyframe time: 0.5', 'Keyframe values must stay within -1024 to 1024'
    ]))
  })
})
