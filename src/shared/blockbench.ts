export const BLOCKBENCH_FORMATS = [
  'java_block',
  'modded_entity',
  'bedrock_block',
  'bedrock',
  'skin',
  'free'
] as const

export type BlockbenchFormat = (typeof BLOCKBENCH_FORMATS)[number]

export interface BlockbenchBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BlockbenchBridgePhase = 'idle' | 'loading' | 'ready' | 'error' | 'destroyed'

export interface BlockbenchBridgeStatus {
  phase: BlockbenchBridgePhase
  visible: boolean
  version?: string
  message?: string
  updatedAt: string
}

export type BlockbenchVector3 = [number, number, number]
export type BlockbenchVector2 = [number, number]
export type BlockbenchFace = 'north' | 'east' | 'south' | 'west' | 'up' | 'down'

export interface BlockbenchMeshFaceInput {
  id?: string
  vertices: string[]
  uv?: Record<string, BlockbenchVector2>
  textureUuid?: string
  textureName?: string
}

export interface BlockbenchTextureStroke {
  points: BlockbenchVector2[]
  color: string
  size?: number
}
export const BLOCKBENCH_VIEW_PRESETS = [
  'initial',
  'top',
  'bottom',
  'south',
  'north',
  'east',
  'west',
  'isometric_right',
  'isometric_left',
  'true_isometric_right',
  'true_isometric_left'
] as const
export type BlockbenchViewPreset = (typeof BLOCKBENCH_VIEW_PRESETS)[number]
export type BlockbenchCommand =
  | 'undo'
  | 'redo'
  | 'frame-all'
  | 'toggle-grid'
  | 'toggle-animate'
  | 'mode-edit'
  | 'mode-paint'
  | 'mode-animate'
  | 'open-project'
  | 'save-project-dialog'

export type BlockbenchAction =
  | {
      type: 'load-source-document'
      document: Omit<import('./modelSource').ModelSourceDocument, 'format'> & { format: 'java_block' | 'bedrock' }
    }
  | {
      type: 'new-model'
      format: BlockbenchFormat
      name: string
      textureWidth?: number
      textureHeight?: number
    }
  | {
      type: 'add-cube'
      name: string
      from: BlockbenchVector3
      to: BlockbenchVector3
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
      inflate?: number
      textureUuid?: string
      textureName?: string
      parentGroupUuid?: string
      parentGroupName?: string
    }
  | {
      type: 'add-group'
      name: string
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
      parentGroupUuid?: string
      parentGroupName?: string
    }
  | {
      type: 'update-cube'
      cubeUuid?: string
      cubeName?: string
      from?: BlockbenchVector3
      to?: BlockbenchVector3
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
      inflate?: number
    }
  | {
      type: 'update-group'
      groupUuid?: string
      groupName?: string
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
    }
  | {
      type: 'add-mesh'
      name: string
      vertices: Record<string, BlockbenchVector3>
      faces: BlockbenchMeshFaceInput[]
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
      shading?: 'flat' | 'smooth'
      parentGroupUuid?: string
      parentGroupName?: string
    }
  | {
      type: 'update-mesh'
      meshUuid?: string
      meshName?: string
      vertices?: Record<string, BlockbenchVector3>
      faces?: BlockbenchMeshFaceInput[]
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
      shading?: 'flat' | 'smooth'
    }
  | {
      type: 'delete-elements'
      elementUuids: string[]
    }
  | {
      type: 'duplicate-element'
      elementUuid: string
      name: string
      offset?: BlockbenchVector3
      parentGroupUuid?: string
      parentGroupName?: string
    }
  | {
      type: 'rename-element'
      elementUuid: string
      name: string
    }
  | {
      type: 'reparent-element'
      elementUuid: string
      parentGroupUuid?: string
      parentGroupName?: string
      root?: boolean
    }
  | {
      type: 'update-cube-faces'
      cubeUuid?: string
      cubeName?: string
      faces: Partial<Record<BlockbenchFace, {uv?: [number, number, number, number]; rotation?: number; textureUuid?: string; textureName?: string; enabled?: boolean}>>
    }
  | {
      type: 'paint-texture'
      textureUuid?: string
      textureName?: string
      rectangles?: Array<{x: number; y: number; width: number; height: number; color: string}>
      strokes?: BlockbenchTextureStroke[]
      paletteMap?: Record<string, string>
    }
  | {
      type: 'auto-unwrap-mesh'
      meshUuid?: string
      meshName?: string
      textureWidth?: number
      textureHeight?: number
      padding?: number
    }
  | {
      type: 'add-armature'
      name: string
      origin?: BlockbenchVector3
    }
  | {
      type: 'add-bone'
      name: string
      armatureUuid?: string
      armatureName?: string
      parentBoneUuid?: string
      parentBoneName?: string
      origin?: BlockbenchVector3
      rotation?: BlockbenchVector3
    }
  | {
      type: 'set-vertex-weights'
      meshUuid?: string
      meshName?: string
      weights: Record<string, Array<{boneUuid?: string; boneName?: string; weight: number}>>
    }
  | {
      type: 'add-locator'
      name: string
      position: BlockbenchVector3
      parentGroupUuid?: string
      parentGroupName?: string
    }
  | {
      type: 'add-ik-target'
      name: string
      position: BlockbenchVector3
      targetGroupUuid?: string
      targetGroupName?: string
      sourceGroupUuid?: string
      sourceGroupName?: string
      lockRotation?: boolean
    }
  | {
      type: 'set-asset-metadata'
      metadata: BlockbenchAssetMetadata
    }
  | {
      type: 'add-animation'
      name: string
      length: number
      loop?: 'once' | 'loop' | 'hold'
      snapping?: number
    }
  | {
      type: 'add-keyframe'
      animationUuid?: string
      animationName?: string
      groupUuid?: string
      groupName?: string
      channel: 'rotation' | 'position' | 'scale'
      time: number
      value: BlockbenchVector3
      interpolation?: 'linear' | 'catmullrom' | 'step' | 'bezier'
    }
  | {
      type: 'create-texture'
      name: string
      width: number
      height: number
      dataUrl?: string
      fill?: string
      rectangles?: Array<{ x: number; y: number; width: number; height: number; color: string }>
    }
  | {
      type: 'set-cube-texture'
      cubeUuid?: string
      textureUuid?: string
      cubeName?: string
      textureName?: string
      faces?: BlockbenchFace[]
    }
  | {
      type: 'save-project'
      relativePath: string
    }
  | {
      type: 'export-model'
      relativePath: string
    }
  | {
      type: 'save-texture'
      relativePath: string
      textureUuid?: string
      textureName?: string
    }
  | {
      type: 'run-command'
      command: BlockbenchCommand
    }

export interface BlockbenchActionResult {
  action: BlockbenchAction['type']
  success: true
  message: string
  data?: Record<string, string | number | boolean>
}

export interface BlockbenchFaceState {
  uv?: [number, number, number, number]
  rotation?: number
  textureUuid?: string
  enabled: boolean
}

export interface BlockbenchCubeState {
  kind: 'cube'
  uuid: string
  name: string
  parentUuid?: string
  from: BlockbenchVector3
  to: BlockbenchVector3
  origin: BlockbenchVector3
  rotation: BlockbenchVector3
  inflate: number
  visibility: boolean
  boxUv: boolean
  uvOffset?: [number, number]
  faces: Record<BlockbenchFace, BlockbenchFaceState>
}

export interface BlockbenchGroupState {
  kind: 'group'
  uuid: string
  name: string
  parentUuid?: string
  origin: BlockbenchVector3
  rotation: BlockbenchVector3
  visibility: boolean
  children: string[]
}

export interface BlockbenchMeshState {
  kind: 'mesh'
  uuid: string
  name: string
  parentUuid?: string
  origin: BlockbenchVector3
  rotation: BlockbenchVector3
  visibility: boolean
  shading: 'flat' | 'smooth'
  vertices: Record<string, BlockbenchVector3>
  faces: Record<string, {vertices: string[]; uv: Record<string, BlockbenchVector2>; textureUuid?: string}>
  seams: Record<string, string>
  vertexCount: number
  faceCount: number
  geometryHash: string
}

export interface BlockbenchArmatureState {
  uuid: string
  name: string
  origin: BlockbenchVector3
  children: string[]
}

export interface BlockbenchBoneState {
  uuid: string
  name: string
  parentUuid?: string
  origin: BlockbenchVector3
  rotation: BlockbenchVector3
  vertexWeights: Record<string, number>
  children: string[]
}

export interface BlockbenchLocatorState {
  uuid: string
  name: string
  parentUuid?: string
  position: BlockbenchVector3
}

export interface BlockbenchIkTargetState extends BlockbenchLocatorState {
  targetUuid?: string
  sourceUuid?: string
  lockRotation: boolean
}

export interface BlockbenchTextureState {
  uuid: string
  name: string
  width: number
  height: number
  visible: boolean
  saved: boolean
  pixelHash: string
  source?: string
}

export type BlockbenchAssetSource = 'GENERATED' | 'REFINED' | 'MANUAL'

export interface BlockbenchAssetMetadata {
  source: BlockbenchAssetSource
  intentHash?: string
  generatedAt?: string
  refinedFrom?: string
}

export interface BlockbenchAssetSaveRequest {
  projectRelativePath: string
  textureRelativePath: string
  textureName: string
  metadata: BlockbenchAssetMetadata
}

export interface BlockbenchAssetSaveResult {
  projectRelativePath: string
  textureRelativePath: string
  textureBytes: number
}

export interface BlockbenchAnimationState {
  uuid: string
  name: string
  length: number
  loop: string
  snapping: number
  selected: boolean
  contentHash: string
  animators: Array<{
    targetUuid: string
    rotationKeyframes: number
    positionKeyframes: number
    scaleKeyframes: number
  }>
}

export interface BlockbenchProjectState {
  revision: string
  project: {
    uuid: string
    name: string
    saved: boolean
    textureWidth: number
    textureHeight: number
  }
  metadata?: BlockbenchAssetMetadata
  format: { id: string; name: string }
  counts: { cubes: number; groups: number; meshes: number; textures: number; animations: number }
  cubes: BlockbenchCubeState[]
  groups: BlockbenchGroupState[]
  meshes: BlockbenchMeshState[]
  armatures?: BlockbenchArmatureState[]
  bones?: BlockbenchBoneState[]
  locators?: BlockbenchLocatorState[]
  ikTargets?: BlockbenchIkTargetState[]
  textures: BlockbenchTextureState[]
  animations: BlockbenchAnimationState[]
  selection: string[]
}

export type BlockbenchValidationSeverity = 'error' | 'warning' | 'info'

export interface BlockbenchValidationFinding {
  severity: BlockbenchValidationSeverity
  checkId: string
  message: string
  targetUuid?: string
  targetName?: string
}

export interface BlockbenchValidationResult {
  revision: string
  valid: boolean
  findings: BlockbenchValidationFinding[]
  counts: Record<BlockbenchValidationSeverity, number>
}

export interface BlockbenchCaptureRequest {
  views?: BlockbenchViewPreset[]
  width?: number
  height?: number
}

export interface BlockbenchCaptureFrame {
  view: BlockbenchViewPreset
  width: number
  height: number
  dataUrl: string
}

export interface BlockbenchCaptureResult {
  revision: string
  captures: BlockbenchCaptureFrame[]
}

export interface BlockbenchActionBatchResult {
  revisionBefore: string
  revisionAfter: string
  results: BlockbenchActionResult[]
}

export interface BlockbenchHistoryEntry {
  id: string
  label: string
  createdAt: string
  revision: string
  projectName: string
  actionCount: number
}

export interface BlockbenchDiffEntry {
  category: 'cube' | 'group' | 'mesh' | 'texture' | 'animation' | 'armature' | 'bone' | 'locator' | 'ik-target'
  change: 'added' | 'removed' | 'changed'
  uuid?: string
  name: string
  fields: string[]
}

export interface BlockbenchProjectDiff {
  revisionBefore: string
  revisionAfter: string
  entries: BlockbenchDiffEntry[]
  counts: {added: number; removed: number; changed: number}
}
