import { describe, expect, it } from 'vitest'
import { compileAssetIntent } from "../../feature-plugins/model-studio/src/main/assetIntentCompiler"
import { validateAction } from "../../feature-plugins/model-studio/src/main/blockbenchBridge"

const ravenIntent = {
  version: 1,
  metadata: {name: 'Ember Raven', quality: 'hero', domain: 'organism'},
  model: {
    format: 'modded_entity', textureWidth: 64, textureHeight: 64, symmetry: 'bilateral',
    parts: [
      {id: 'body', kind: 'body', size: [8, 10, 6], offset: [0, 8, 0]},
      {id: 'head', kind: 'head', parent: 'body', size: [6, 6, 6], offset: [0, 17, -1]},
      {id: 'wing', kind: 'wing', parent: 'body', side: 'left', size: [2, 7, 8], offset: [6, 9, 0]},
      {id: 'tail', kind: 'tail', parent: 'body', size: [4, 4, 8], offset: [0, 6, 7]}
    ]
  },
  appearance: {palette: 'ember', texture: 'mottle', seed: 'raven-1'},
  animation: {
    name: 'idle', length: 1, loop: 'loop',
    tracks: [{part: 'wing', channel: 'rotation', keyframes: [
      {time: 0, value: [0, 0, 0]}, {time: 0.5, value: [8, 0, 0], interpolation: 'catmullrom'}, {time: 1, value: [0, 0, 0]}
    ]}]
  }
}

describe('Ashfox-style Asset Intent compiler', () => {
  it('compiles deterministic mirrored geometry, texture, and animation actions', () => {
    const first = compileAssetIntent(ravenIntent)
    const second = compileAssetIntent(ravenIntent)
    expect(first.intentHash).toBe(second.intentHash)
    expect(first.actions).toEqual(second.actions)
    expect(first.diagnostics).toEqual([])
    expect(first.summary).toMatchObject({name: 'Ember Raven', parts: 5, mirroredParts: 1, textures: 1, animations: 1})
    expect(first.actions.filter((action) => action.type === 'new-model')).toHaveLength(1)
    expect(first.actions.filter((action) => action.type === 'create-texture')).toHaveLength(1)
    expect(first.actions.filter((action) => action.type === 'add-group')).toHaveLength(5)
    expect(first.actions.filter((action) => action.type === 'add-cube')).toHaveLength(5)
    expect(first.actions.filter((action) => action.type === 'add-keyframe')).toHaveLength(6)
    expect(first.actions.map((action) => validateAction(action))).toEqual(first.actions)
    expect(first.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'add-group', name: 'wing_left'}),
      expect.objectContaining({type: 'add-group', name: 'wing_right'})
    ]))
    expect(first.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'add-keyframe', groupName: 'wing_left', value: [8, 0, 0]}),
      expect.objectContaining({type: 'add-keyframe', groupName: 'wing_right', value: [8, 0, 0]})
    ]))
  })

  it('reports semantic reference errors without producing mutation actions', () => {
    const candidate = compileAssetIntent({
      ...ravenIntent,
      model: {...ravenIntent.model, parts: [{id: 'body', kind: 'body', parent: 'missing', size: [8, 8, 8]}]},
      animation: {name: 'idle', length: 1, tracks: [{part: 'missing', channel: 'rotation', keyframes: [{time: 2, value: [0, 0, 0]}]}]}
    })
    expect(candidate.actions).toEqual([])
    expect(candidate.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      'Unknown parent part: missing', 'Unknown animation target: missing'
    ]))
  })

  it('rejects malformed programs before compilation', () => {
    expect(() => compileAssetIntent({version: 2})).toThrow(/version/)
    expect(() => compileAssetIntent({...ravenIntent, model: {...ravenIntent.model, parts: []}})).toThrow(/model.parts/)
  })

  it('rejects animation for formats that cannot export editable animation tracks', () => {
    const candidate = compileAssetIntent({
      ...ravenIntent,
      model: {...ravenIntent.model, format: 'java_block'}
    })
    expect(candidate.actions).toEqual([])
    expect(candidate.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', path: 'animation', message: expect.stringContaining('java_block')
    }))
  })

  it('rejects values and bilateral IDs that the action layer cannot apply', () => {
    const outOfRange = compileAssetIntent({
      ...ravenIntent,
      model: {...ravenIntent.model, parts: [{id: 'body', kind: 'body', size: [8, 8, 8], offset: [1022, 0, 0], inflate: 65}]},
      animation: {name: 'idle', length: 3601, tracks: [{part: 'body', channel: 'position', keyframes: [{time: 0, value: [2048, 0, 0]}]}]}
    })
    expect(outOfRange.actions).toEqual([])
    expect(outOfRange.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(expect.arrayContaining([
      'model.parts[0].offset', 'model.parts[0].inflate', 'animation.length', 'animation.tracks[0].keyframes'
    ]))

    const duplicateExpansion = compileAssetIntent({
      ...ravenIntent,
      model: {...ravenIntent.model, parts: [
        {id: 'wing', kind: 'wing', side: 'left', size: [2, 4, 6]},
        {id: 'wing_left', kind: 'wing', size: [2, 4, 6]}
      ]},
      animation: undefined
    })
    expect(duplicateExpansion.actions).toEqual([])
    expect(duplicateExpansion.diagnostics).toContainEqual(expect.objectContaining({message: expect.stringContaining('duplicate part id')}))
  })
})
