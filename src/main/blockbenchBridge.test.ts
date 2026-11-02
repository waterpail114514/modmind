import { BlockbenchBridge } from '../../feature-plugins/model-studio/src/main/blockbenchBridge'
import { describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BlockbenchAction, BlockbenchProjectState } from '../shared/blockbench'
import { validateAction, validateCaptureRequest, validateProjectState } from "../../feature-plugins/model-studio/src/main/blockbenchBridge"

describe('Blockbench production actions', () => {
  const sourceAction = { type: 'load-source-document', document: { name: 'Model', format: 'bedrock', model: {}, textures: [], animations: [] } } as const
  it('accepts bounded native imports and rejects internal page commands and external texture sources', () => {
    expect(validateAction(JSON.parse(JSON.stringify(sourceAction)))).toMatchObject({ type: 'load-source-document' })
    for (const type of ['serialize-project', 'serialize-export', 'snapshot-project', 'restore-project-snapshot', 'active-project', 'clone-project', 'capture-views', 'inspect-project']) {
      expect(() => validateAction({ type } as BlockbenchAction)).toThrow('Unsupported')
    }
    expect(() => validateAction({ ...sourceAction, document: { ...sourceAction.document, format: 'project' } } as unknown as BlockbenchAction)).toThrow('codecs')
    expect(() => validateAction({ ...sourceAction, document: { ...sourceAction.document, format: 'java_block', model: { textures: { all: 'file:///C:/secret.png' } }, textures: [], animations: [] } })).toThrow('resource identifiers')
    expect(() => validateAction({ ...sourceAction, document: { ...sourceAction.document, textures: [{ id: '0', name: 'x', dataUrl: 'https://example.org/x.png' }], animations: [] } })).toThrow('embedded PNG')
  })

  it('rolls back an imported document on later action failure and rejects a second document before execution', async () => {
    const discard = vi.fn(async () => {})
    const invoke = vi.fn(async () => ({ data: { projectUuid: 'imported' }, message: 'loaded' }))
    const bridge = Object.assign(Object.create(BlockbenchBridge.prototype), {
      actionQueue: Promise.resolve(), operationProject: new AsyncLocalStorage(), getProjectRoot: () => '/project',
      status: { phase: 'ready' }, assertAlive: () => {}, invokePage: invoke,
      activeProjectUuid: async () => 'original', readProjectState: async () => ({ revision: `sha256:${'a'.repeat(64)}` }),
      discardCandidateProjects: discard
    }) as BlockbenchBridge
    const fail = vi.spyOn(bridge as unknown as { executeValidatedAction: (action: BlockbenchAction) => Promise<unknown> }, 'executeValidatedAction')
    fail.mockImplementationOnce(async () => ({ data: { projectUuid: 'imported' } })).mockRejectedValueOnce(new Error('later action failed'))
    const action = JSON.parse(JSON.stringify(sourceAction)) as BlockbenchAction
    await expect(bridge.executeActions([action, { type: 'run-command', command: 'frame-all' }])).rejects.toThrow('was discarded')
    expect(discard).toHaveBeenCalledWith(['imported'], 'original')
    fail.mockRestore()
    await expect(bridge.executeActions([action, { type: 'new-model', name: 'Second', format: 'bedrock' }])).rejects.toThrow('first and only')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('accepts groups, animation keyframes, and model export', () => {
    expect(validateAction({ type: 'add-group', name: 'body', origin: [0, 12, 0] })).toMatchObject({ type: 'add-group', name: 'body' })
    expect(validateAction({ type: 'add-animation', name: 'idle', length: 2, loop: 'loop', snapping: 20 })).toMatchObject({ type: 'add-animation', loop: 'loop' })
    expect(validateAction({
      type: 'add-keyframe', animationName: 'idle', groupName: 'body', channel: 'rotation',
      time: 1, value: [0, 5, 0], interpolation: 'linear'
    })).toMatchObject({ type: 'add-keyframe', channel: 'rotation' })
    expect(validateAction({ type: 'export-model', relativePath: 'src/main/resources/assets/example/models/entity/model.geo.json' }))
      .toMatchObject({ type: 'export-model' })
  })

  it('blocks export and save paths inside protected project directories', () => {
    expect(() => validateAction({ type: 'export-model', relativePath: '.git/model.json' } as BlockbenchAction)).toThrow(/safe project-relative/)
    expect(() => validateAction({ type: 'save-project', relativePath: '.modmind/model.bbmodel' })).toThrow(/safe project-relative/)
    expect(() => validateAction({ type: 'save-texture', relativePath: 'build/output.png', textureName: 'atlas' })).toThrow(/safe project-relative/)
  })

  it('accepts complete mesh, UV, texture-paint, rig, and IK edits', () => {
    const vertices: Record<string, [number, number, number]> = {a: [0, 0, 0], b: [4, 0, 0], c: [0, 4, 0]}
    expect(validateAction({
      type: 'add-mesh', name: 'profile', vertices: {...vertices},
      faces: [{id: 'front', vertices: ['a', 'b', 'c'], uv: {a: [0, 0], b: [4, 0], c: [0, 4]}}], shading: 'smooth'
    })).toMatchObject({type: 'add-mesh', name: 'profile'})
    expect(validateAction({type: 'auto-unwrap-mesh', meshName: 'profile', textureWidth: 64, textureHeight: 64, padding: 1}))
      .toMatchObject({type: 'auto-unwrap-mesh'})
    expect(validateAction({
      type: 'paint-texture', textureName: 'atlas', rectangles: [{x: 1, y: 1, width: 2, height: 2, color: '#ff0000'}],
      strokes: [{points: [[0, 0], [4, 4]], color: '#ffffff', size: 1}], paletteMap: {'#000000': '#101010'}
    })).toMatchObject({type: 'paint-texture'})
    expect(validateAction({type: 'add-armature', name: 'rig'})).toMatchObject({type: 'add-armature'})
    expect(validateAction({type: 'add-bone', name: 'root', armatureName: 'rig', origin: [0, 0, 0]})).toMatchObject({type: 'add-bone'})
    expect(validateAction({type: 'set-vertex-weights', meshName: 'profile', weights: {a: [{boneName: 'root', weight: 1}]}}))
      .toMatchObject({type: 'set-vertex-weights'})
    expect(validateAction({type: 'add-ik-target', name: 'hand_ik', position: [0, 4, 0], targetGroupName: 'hand', sourceGroupName: 'arm'}))
      .toMatchObject({type: 'add-ik-target'})
  })

  it('rejects incomplete topology, unsafe UV edits, and ambiguous rig actions', () => {
    expect(() => validateAction({
      type: 'add-mesh', name: 'broken', vertices: {a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0]},
      faces: [{vertices: ['a', 'b', 'missing']}]
    })).toThrow(/unknown vertex/)
    expect(() => validateAction({type: 'update-mesh', meshName: 'mesh', faces: [{vertices: ['a', 'b', 'c']}]}))
      .toThrow(/complete vertex map/)
    expect(() => validateAction({type: 'paint-texture', textureName: 'atlas'})).toThrow(/no changes/)
    expect(() => validateAction({type: 'add-bone', name: 'bone', armatureName: 'rig', parentBoneName: 'root'}))
      .toThrow(/either an armature or a parent bone/)
    expect(() => validateAction({type: 'reparent-element', elementUuid: 'cube', root: true, parentGroupName: 'body'}))
      .toThrow(/either root or one parent/)
    expect(() => validateAction({type: 'set-vertex-weights', meshName: 'mesh', weights: {
      a: [{boneName: 'one', weight: 0.25}, {boneName: 'two', weight: 0.25}, {boneName: 'three', weight: 0.25},
        {boneName: 'four', weight: 0.2}, {boneName: 'five', weight: 0.05}]
    }})).toThrow(/1 to 4/)
  })
})

describe('Blockbench AI inspection foundation', () => {
  it('normalizes bounded native camera presets and rejects ambiguous captures', () => {
    expect(validateCaptureRequest({})).toEqual({
      views: ['isometric_right', 'north', 'south', 'west'], width: 512, height: 512
    })
    expect(validateCaptureRequest({ views: ['top'], width: 256, height: 384 })).toEqual({
      views: ['top'], width: 256, height: 384
    })
    expect(() => validateCaptureRequest({ views: ['north', 'north'] })).toThrow(/unique/)
    expect(() => validateCaptureRequest({ width: 64 })).toThrow(/128 to 1024/)
  })

  it('returns structured findings for hierarchy, texture, and animation defects', () => {
    const state: BlockbenchProjectState = {
      revision: `sha256:${'a'.repeat(64)}`,
      project: { uuid: 'project', name: 'Example', saved: false, textureWidth: 16, textureHeight: 16 },
      format: { id: 'java_block', name: 'Java Block' },
      counts: { cubes: 1, groups: 1, meshes: 0, textures: 1, animations: 1 },
      groups: [{
        kind: 'group', uuid: 'body', name: 'body', parentUuid: 'body', origin: [0, 0, 0],
        rotation: [0, 0, 0], visibility: true, children: ['cube']
      }],
      cubes: [{
        kind: 'cube', uuid: 'cube', name: 'body', parentUuid: 'missing', from: [0, 0, 0], to: [40, 16, 16],
        origin: [0, 0, 0], rotation: [0, 0, 0], inflate: 0, visibility: true, boxUv: false,
        faces: {
          north: { enabled: true, textureUuid: 'missing-texture' }, east: { enabled: true },
          south: { enabled: true }, west: { enabled: true }, up: { enabled: true }, down: { enabled: true }
        }
      }],
      meshes: [],
      textures: [{ uuid: 'texture', name: 'atlas', width: 32, height: 32, visible: true, saved: false, pixelHash: 'pixels' }],
      animations: [{
        uuid: 'idle', name: 'idle', length: 1, loop: 'loop', snapping: 20, selected: false, contentHash: 'animation',
        animators: [{ targetUuid: 'missing-bone', rotationKeyframes: 2, positionKeyframes: 0, scaleKeyframes: 0 }]
      }],
      selection: []
    }

    const result = validateProjectState(state)
    expect(result.valid).toBe(false)
    expect(result.counts.error).toBeGreaterThanOrEqual(4)
    expect(result.findings.map((finding) => finding.checkId)).toEqual(expect.arrayContaining([
      'group-cycle', 'missing-parent-group', 'missing-texture-reference', 'untextured-faces',
      'java-block-display-bounds', 'texture-resolution-mismatch', 'missing-animation-target'
    ]))
  })
})
