import {createHash} from 'node:crypto'
import type {
  AdvancedAssetCandidate,
  AdvancedAssetPrimitive,
  AdvancedAssetProgram,
  AdvancedAssetVariant
} from "../../../../src/shared/advancedAsset"
import type {BlockbenchAction, BlockbenchMeshFaceInput, BlockbenchVector3} from "../../../../src/shared/blockbench"
import {validateAction} from "./blockbenchBridge"

interface MeshGeometry {
  vertices: Record<string, BlockbenchVector3>
  faces: BlockbenchMeshFaceInput[]
}

const DEFAULT_TEXTURE_SIZE = 64

export function compileAdvancedAsset(input: unknown, variantId = 'base'): AdvancedAssetCandidate {
  const source = normalizeAdvancedProgram(input)
  const variant = variantId === 'base' ? undefined : source.variants?.find((candidate) => candidate.id === variantId)
  if (variantId !== 'base' && !variant) throw new Error(`Unknown advanced asset variant: ${variantId}`)
  const program = applyVariant(source, variant)
  const diagnostics: AdvancedAssetCandidate['diagnostics'] = []
  const actions: BlockbenchAction[] = []
  const format = program.model.format ?? 'free'
  const textureWidth = program.texture?.width ?? program.model.textureWidth ?? DEFAULT_TEXTURE_SIZE
  const textureHeight = program.texture?.height ?? program.model.textureHeight ?? DEFAULT_TEXTURE_SIZE
  const textureName = program.texture?.name ?? `${slug(program.metadata.name)}_atlas`
  const meshGeometry = new Map<string, MeshGeometry>()
  const primitiveIds = new Set<string>()

  for (const [index, primitive] of program.model.primitives.entries()) {
    if (primitiveIds.has(primitive.id)) diagnostics.push({severity: 'error', path: `model.primitives[${index}].id`, message: `Duplicate primitive id: ${primitive.id}`})
    primitiveIds.add(primitive.id)
  }
  for (const [index, primitive] of program.model.primitives.entries()) {
    if (primitive.parent && !primitiveIds.has(primitive.parent) && !program.rig?.bones.some((bone) => bone.id === primitive.parent)) {
      diagnostics.push({severity: 'error', path: `model.primitives[${index}].parent`, message: `Unknown primitive or bone parent: ${primitive.parent}`})
    }
  }
  validateRig(program, primitiveIds, diagnostics)
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return emptyCandidate(program, variantId, format, diagnostics)

  actions.push({type: 'new-model', format, name: program.metadata.name, textureWidth, textureHeight})
  actions.push({
    type: 'create-texture', name: textureName, width: textureWidth, height: textureHeight,
    fill: program.texture?.fill ?? '#808080ff', rectangles: program.texture?.rectangles
  })
  if (program.texture?.strokes?.length) actions.push({type: 'paint-texture', textureName, strokes: program.texture.strokes})

  if (program.rig) {
    actions.push({type: 'add-armature', name: program.rig.name})
    for (const bone of topologicalBones(program.rig.bones)) {
      actions.push({
        type: 'add-bone', name: bone.id,
        ...(bone.parent ? {parentBoneName: bone.parent} : {armatureName: program.rig.name}),
        origin: bone.origin, rotation: bone.rotation
      })
    }
  }

  for (const primitive of topologicalPrimitives(program.model.primitives)) {
    const center = primitive.center ?? [0, 0, 0]
    actions.push({
      type: 'add-group', name: primitive.id, origin: center, rotation: primitive.rotation,
      ...(primitive.parent ? {parentGroupName: primitive.parent} : {})
    })
    if (primitive.type === 'cube') {
      const from = center.map((value, axis) => value - primitive.size[axis] / 2) as BlockbenchVector3
      const to = center.map((value, axis) => value + primitive.size[axis] / 2) as BlockbenchVector3
      actions.push({
        type: 'add-cube', name: `${primitive.id}_cube`, from, to, origin: center,
        inflate: primitive.inflate, textureName, parentGroupName: primitive.id
      })
      continue
    }
    const geometry = geometryForPrimitive(primitive)
    meshGeometry.set(primitive.id, geometry)
    actions.push({
      type: 'add-mesh', name: `${primitive.id}_mesh`, vertices: geometry.vertices,
      faces: geometry.faces.map((face) => ({...face, textureName})), origin: center,
      shading: primitive.shading ?? (primitive.type === 'wedge' || primitive.type === 'extrude' ? 'flat' : 'smooth'),
      parentGroupName: primitive.id
    })
    actions.push({type: 'auto-unwrap-mesh', meshName: `${primitive.id}_mesh`, textureWidth, textureHeight, padding: 1})
  }

  if (program.rig) {
    appendWeightActions(actions, program, meshGeometry, diagnostics)
    for (const locator of program.rig.locators ?? []) {
      actions.push({type: 'add-locator', name: locator.id, position: locator.position, ...(locator.parent ? {parentGroupName: locator.parent} : {})})
    }
    for (const ik of program.rig.ik ?? []) {
      actions.push({
        type: 'add-ik-target', name: ik.id, position: ik.position, targetGroupName: ik.target,
        sourceGroupName: ik.source, lockRotation: ik.lockRotation
      })
    }
  }

  for (const animation of program.animations ?? []) {
    actions.push({type: 'add-animation', name: animation.name, length: animation.length, loop: animation.loop, snapping: animation.snapping})
    for (const track of animation.tracks) {
      for (const keyframe of track.keyframes) {
        actions.push({
          type: 'add-keyframe', animationName: animation.name, groupName: track.target, channel: track.channel,
          time: keyframe.time, value: keyframe.value, interpolation: keyframe.interpolation
        })
      }
    }
  }

  const programHash = stableHash(program)
  actions.push({type: 'set-asset-metadata', metadata: {source: 'GENERATED', intentHash: programHash, generatedAt: new Date(0).toISOString()}})
  if (actions.length > 500) diagnostics.push({severity: 'error', path: 'program', message: 'Advanced asset expands beyond the 500-action transaction limit'})
  for (const [index, action] of actions.entries()) {
    try {
      validateAction(action)
    } catch (error) {
      diagnostics.push({severity: 'error', path: `actions[${index}]`, message: error instanceof Error ? error.message : String(error)})
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) actions.length = 0
  const meshes = [...meshGeometry.values()]
  return {
    candidateVersion: 1, programHash, variantId, label: variant?.label ?? (variantId === 'base' ? 'Base' : variantId), program,
    actions, diagnostics,
    summary: {
      name: program.metadata.name, format, primitives: program.model.primitives.length,
      meshes: meshes.length, cubes: program.model.primitives.length - meshes.length,
      vertices: meshes.reduce((sum, mesh) => sum + Object.keys(mesh.vertices).length, 0),
      faces: meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0),
      bones: program.rig?.bones.length ?? 0, animations: program.animations?.length ?? 0
    }
  }
}

export function compileAdvancedAssetVariants(input: unknown): AdvancedAssetCandidate[] {
  const program = normalizeAdvancedProgram(input)
  return ['base', ...(program.variants ?? []).slice(0, 2).map((variant) => variant.id)]
    .map((variantId) => compileAdvancedAsset(program, variantId))
}

export function optimizeAdvancedProgram(input: AdvancedAssetProgram, mode: 'occupancy-up' | 'occupancy-down' | 'contrast'): AdvancedAssetProgram {
  const program = structuredClone(input)
  if (mode === 'contrast') {
    program.texture = {...program.texture, fill: '#30343aff'}
    program.texture.rectangles = [...(program.texture.rectangles ?? []), {x: 0, y: 0, width: 8, height: 8, color: '#e6bd55ff'}]
    return program
  }
  const scale = mode === 'occupancy-up' ? 1.12 : 0.9
  program.model.primitives = program.model.primitives.map((primitive) => scalePrimitive(primitive, scale))
  return program
}

function emptyCandidate(
  program: AdvancedAssetProgram,
  variantId: string,
  format: AdvancedAssetCandidate['summary']['format'],
  diagnostics: AdvancedAssetCandidate['diagnostics']
): AdvancedAssetCandidate {
  return {
    candidateVersion: 1, programHash: stableHash(program), variantId, label: variantId === 'base' ? 'Base' : variantId,
    program, actions: [], diagnostics,
    summary: {name: program.metadata.name, format, primitives: program.model.primitives.length, meshes: 0, cubes: 0, vertices: 0, faces: 0, bones: program.rig?.bones.length ?? 0, animations: program.animations?.length ?? 0}
  }
}

function normalizeAdvancedProgram(input: unknown): AdvancedAssetProgram {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Advanced asset program must be an object')
  const program = structuredClone(input) as AdvancedAssetProgram
  if (program.version !== 1) throw new Error('Unsupported advanced asset version')
  if (!program.metadata || typeof program.metadata.name !== 'string' || !program.metadata.name.trim()) throw new Error('Advanced asset metadata.name is required')
  if (!program.model || !Array.isArray(program.model.primitives) || program.model.primitives.length < 1 || program.model.primitives.length > 64) {
    throw new Error('Advanced asset model.primitives must contain 1 to 64 entries')
  }
  if (program.variants && (!Array.isArray(program.variants) || program.variants.length > 2)) throw new Error('Advanced assets support at most two variants in addition to the base candidate')
  program.model.primitives.forEach((primitive, index) => validatePrimitiveShape(primitive, index))
  const variantIds = new Set<string>()
  for (const variant of program.variants ?? []) {
    if (typeof variant.id !== 'string' || !variant.id.trim() || variantIds.has(variant.id)) throw new Error('Advanced asset variant IDs must be non-empty and unique')
    if (variant.scale !== undefined && (!Number.isFinite(variant.scale) || variant.scale <= 0 || variant.scale > 16)) throw new Error('Advanced asset variant scale is invalid')
    variantIds.add(variant.id)
  }
  if ((program.animations ?? []).reduce((sum, animation) => sum + animation.tracks.reduce((trackSum, track) => trackSum + track.keyframes.length, 0), 0) > 300) {
    throw new Error('Advanced asset animations contain more than 300 keyframes')
  }
  return program
}

function applyVariant(program: AdvancedAssetProgram, variant?: AdvancedAssetVariant): AdvancedAssetProgram {
  const result = structuredClone(program)
  result.variants = undefined
  if (!variant) return result
  if (variant.scale !== undefined) result.model.primitives = result.model.primitives.map((primitive) => scalePrimitive(primitive, variant.scale!))
  result.model.primitives = result.model.primitives.map((primitive) => {
    const override = variant.primitiveOverrides?.[primitive.id]
    return override ? {...primitive, ...override} as AdvancedAssetPrimitive : primitive
  })
  if (variant.accent) {
    result.texture = {...result.texture}
    result.texture.rectangles = [...(result.texture.rectangles ?? []), {x: 0, y: 0, width: 8, height: 8, color: variant.accent}]
  }
  return result
}

function scalePrimitive(primitive: AdvancedAssetPrimitive, scale: number): AdvancedAssetPrimitive {
  const scaled = structuredClone(primitive)
  if (scaled.center) scaled.center = scaled.center.map((value) => value * scale) as BlockbenchVector3
  if ('size' in scaled) scaled.size = scaled.size.map((value) => value * scale) as BlockbenchVector3
  if ('radius' in scaled) scaled.radius *= scale
  if ('height' in scaled) scaled.height *= scale
  if ('depth' in scaled) scaled.depth *= scale
  if (scaled.type === 'tube') scaled.path = scaled.path.map((point) => point.map((value) => value * scale) as BlockbenchVector3)
  if (scaled.type === 'extrude') scaled.profile = scaled.profile.map(([x, y]) => [x * scale, y * scale])
  return scaled
}

function geometryForPrimitive(primitive: Exclude<AdvancedAssetPrimitive, {type: 'cube'}>): MeshGeometry {
  switch (primitive.type) {
    case 'wedge': return wedgeGeometry(primitive.size, primitive.center ?? [0, 0, 0])
    case 'cylinder': return cylinderGeometry(primitive.radius, primitive.height, clampInteger(primitive.segments ?? 12, 3, 64), primitive.center ?? [0, 0, 0])
    case 'sphere': return sphereGeometry(primitive.radius, clampInteger(primitive.segments ?? 16, 3, 64), clampInteger(primitive.rings ?? 8, 2, 32), primitive.center ?? [0, 0, 0])
    case 'extrude': return extrudeGeometry(primitive.profile, primitive.depth, primitive.center ?? [0, 0, 0])
    case 'tube': return tubeGeometry(primitive)
  }
}

function wedgeGeometry(size: BlockbenchVector3, center: BlockbenchVector3): MeshGeometry {
  const [hx, hy, hz] = size.map((value) => value / 2)
  const points: BlockbenchVector3[] = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz]]
  return meshFromPoints(points.map((point) => add(point, center)), [[0, 3, 2, 1], [3, 4, 5, 2], [0, 1, 5, 4], [0, 4, 3], [1, 2, 5]])
}

function cylinderGeometry(radius: number, height: number, segments: number, center: BlockbenchVector3): MeshGeometry {
  const points: BlockbenchVector3[] = []
  for (let ring = 0; ring < 2; ring += 1) for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment / segments * Math.PI * 2
    points.push(add([Math.cos(angle) * radius, (ring - 0.5) * height, Math.sin(angle) * radius], center))
  }
  const faces: number[][] = []
  faces.push([...Array(segments).keys()].reverse())
  faces.push([...Array(segments).keys()].map((index) => segments + index))
  for (let index = 0; index < segments; index += 1) faces.push([index, (index + 1) % segments, segments + (index + 1) % segments, segments + index])
  return meshFromPoints(points, faces)
}

function sphereGeometry(radius: number, segments: number, rings: number, center: BlockbenchVector3): MeshGeometry {
  const points: BlockbenchVector3[] = [add([0, radius, 0], center)]
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = ring / rings * Math.PI
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = segment / segments * Math.PI * 2
      points.push(add([Math.sin(phi) * Math.cos(theta) * radius, Math.cos(phi) * radius, Math.sin(phi) * Math.sin(theta) * radius], center))
    }
  }
  const bottom = points.push(add([0, -radius, 0], center)) - 1
  const faces: number[][] = []
  for (let segment = 0; segment < segments; segment += 1) faces.push([0, 1 + segment, 1 + (segment + 1) % segments])
  for (let ring = 0; ring < rings - 2; ring += 1) for (let segment = 0; segment < segments; segment += 1) {
    const current = 1 + ring * segments + segment
    const next = 1 + ring * segments + (segment + 1) % segments
    faces.push([current, 1 + (ring + 1) * segments + segment, 1 + (ring + 1) * segments + (segment + 1) % segments, next])
  }
  const lastRing = 1 + (rings - 2) * segments
  for (let segment = 0; segment < segments; segment += 1) faces.push([lastRing + segment, bottom, lastRing + (segment + 1) % segments])
  return meshFromPoints(points, faces)
}

function extrudeGeometry(profile: [number, number][], depth: number, center: BlockbenchVector3): MeshGeometry {
  if (profile.length < 3 || profile.length > 128) throw new Error('Extrude profile requires 3 to 128 points')
  const points: BlockbenchVector3[] = []
  for (const z of [-depth / 2, depth / 2]) for (const [x, y] of profile) points.push(add([x, y, z], center))
  const count = profile.length
  const faces: number[][] = [[...Array(count).keys()].reverse(), [...Array(count).keys()].map((index) => count + index)]
  for (let index = 0; index < count; index += 1) faces.push([index, (index + 1) % count, count + (index + 1) % count, count + index])
  return meshFromPoints(points, faces)
}

function tubeGeometry(primitive: Extract<AdvancedAssetPrimitive, {type: 'tube'}>): MeshGeometry {
  if (primitive.path.length < 2 || primitive.path.length > 64) throw new Error('Tube path requires 2 to 64 control points')
  const radialSegments = clampInteger(primitive.radialSegments ?? 8, 3, 32)
  const curveSegments = clampInteger(primitive.curveSegments ?? 4, 1, 16)
  const samples = sampleCatmullRom(primitive.path, curveSegments, primitive.closed === true)
  const points: BlockbenchVector3[] = []
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[index === 0 ? (primitive.closed ? samples.length - 1 : 0) : index - 1]
    const next = samples[index === samples.length - 1 ? (primitive.closed ? 0 : samples.length - 1) : index + 1]
    const tangent = normalize(subtract(next, previous))
    const helper: BlockbenchVector3 = Math.abs(tangent[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0]
    const normal = normalize(cross(tangent, helper))
    const binormal = normalize(cross(tangent, normal))
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * Math.PI * 2
      points.push(add(samples[index], add(scale(normal, Math.cos(angle) * primitive.radius), scale(binormal, Math.sin(angle) * primitive.radius))))
    }
  }
  const faces: number[][] = []
  const rings = samples.length
  const links = primitive.closed ? rings : rings - 1
  for (let ring = 0; ring < links; ring += 1) for (let segment = 0; segment < radialSegments; segment += 1) {
    const nextRing = (ring + 1) % rings
    faces.push([ring * radialSegments + segment, ring * radialSegments + (segment + 1) % radialSegments,
      nextRing * radialSegments + (segment + 1) % radialSegments, nextRing * radialSegments + segment])
  }
  if (!primitive.closed) {
    faces.push([...Array(radialSegments).keys()].reverse())
    faces.push([...Array(radialSegments).keys()].map((segment) => (rings - 1) * radialSegments + segment))
  }
  return meshFromPoints(points, faces)
}

function meshFromPoints(points: BlockbenchVector3[], faceIndices: number[][]): MeshGeometry {
  const vertices = Object.fromEntries(points.map((point, index) => [`v${index}`, roundVector(point)]))
  const faces = faceIndices.map((indices, index) => ({id: `f${index}`, vertices: indices.map((item) => `v${item}`)}))
  return {vertices, faces}
}

function appendWeightActions(
  actions: BlockbenchAction[],
  program: AdvancedAssetProgram,
  meshes: Map<string, MeshGeometry>,
  diagnostics: AdvancedAssetCandidate['diagnostics']
): void {
  const rig = program.rig!
  for (const [meshId, weights] of Object.entries(rig.weights ?? {})) {
    if (!meshes.has(meshId)) {
      diagnostics.push({severity: 'warning', path: `rig.weights.${meshId}`, message: `Weight target is not a generated mesh: ${meshId}`})
      continue
    }
    actions.push({
      type: 'set-vertex-weights', meshName: `${meshId}_mesh`,
      weights: Object.fromEntries(Object.entries(weights).map(([vertex, entries]) => [vertex, entries.map((entry) => ({boneName: entry.bone, weight: entry.weight}))]))
    })
  }
  for (const rule of rig.weightRules ?? []) {
    const mesh = meshes.get(rule.mesh)
    if (!mesh) {
      diagnostics.push({severity: 'warning', path: 'rig.weightRules', message: `Weight rule target is not a generated mesh: ${rule.mesh}`})
      continue
    }
    const axis = rule.axis ?? 1
    const values = Object.values(mesh.vertices).map((vertex) => vertex[axis])
    const split = rule.split ?? (Math.min(...values) + Math.max(...values)) / 2
    const blend = Math.max(0, rule.blend ?? 0)
    const weights = Object.fromEntries(Object.entries(mesh.vertices).map(([vertex, position]) => {
      const upper = blend === 0 ? (position[axis] >= split ? 1 : 0) : clamp((position[axis] - (split - blend / 2)) / blend, 0, 1)
      const entries = [
        ...(upper < 1 ? [{boneName: rule.lowerBone, weight: 1 - upper}] : []),
        ...(upper > 0 ? [{boneName: rule.upperBone, weight: upper}] : [])
      ]
      return [vertex, entries]
    }))
    actions.push({type: 'set-vertex-weights', meshName: `${rule.mesh}_mesh`, weights})
  }
}

function validateRig(program: AdvancedAssetProgram, primitiveIds: Set<string>, diagnostics: AdvancedAssetCandidate['diagnostics']): void {
  const rig = program.rig
  const bones = new Set((rig?.bones ?? []).map((bone) => bone.id))
  const targets = new Set([...primitiveIds, ...bones])
  for (const animation of program.animations ?? []) for (const track of animation.tracks) if (!targets.has(track.target)) {
    diagnostics.push({severity: 'error', path: `animations.${animation.name}`, message: `Unknown animation target: ${track.target}`})
  }
  if (!rig) return
  if (bones.size !== rig.bones.length) diagnostics.push({severity: 'error', path: 'rig.bones', message: 'Bone IDs must be unique'})
  for (const [index, bone] of rig.bones.entries()) if (bone.parent && !bones.has(bone.parent)) {
    diagnostics.push({severity: 'error', path: `rig.bones[${index}].parent`, message: `Unknown parent bone: ${bone.parent}`})
  }
  for (const rule of rig.weightRules ?? []) {
    if (!primitiveIds.has(rule.mesh)) diagnostics.push({severity: 'error', path: 'rig.weightRules', message: `Unknown weight mesh: ${rule.mesh}`})
    if (!bones.has(rule.lowerBone) || !bones.has(rule.upperBone)) diagnostics.push({severity: 'error', path: 'rig.weightRules', message: 'Weight rule references an unknown bone'})
  }
  for (const [mesh, vertices] of Object.entries(rig.weights ?? {})) {
    if (!primitiveIds.has(mesh)) diagnostics.push({severity: 'error', path: `rig.weights.${mesh}`, message: `Unknown weight mesh: ${mesh}`})
    for (const entries of Object.values(vertices)) if (entries.some((entry) => !bones.has(entry.bone))) {
      diagnostics.push({severity: 'error', path: `rig.weights.${mesh}`, message: 'Explicit weight references an unknown bone'})
      break
    }
  }
  for (const ik of rig.ik ?? []) if (!bones.has(ik.target) || !bones.has(ik.source)) diagnostics.push({severity: 'error', path: 'rig.ik', message: 'IK target or source bone does not exist'})
}

function validatePrimitiveShape(primitive: AdvancedAssetPrimitive, index: number): void {
  if (!primitive || typeof primitive !== 'object' || typeof primitive.id !== 'string' || !primitive.id.trim()) throw new Error(`model.primitives[${index}].id is invalid`)
  if (primitive.center !== undefined) assertFiniteVector(primitive.center, `model.primitives[${index}].center`, 3)
  if (primitive.rotation !== undefined) assertFiniteVector(primitive.rotation, `model.primitives[${index}].rotation`, 3)
  if (primitive.type === 'cube' || primitive.type === 'wedge') {
    assertFiniteVector(primitive.size, `model.primitives[${index}].size`, 3)
    if (primitive.size.some((value) => value <= 0 || value > 512)) throw new Error(`model.primitives[${index}].size is outside the supported range`)
  } else if (primitive.type === 'cylinder' || primitive.type === 'sphere') {
    if (!Number.isFinite(primitive.radius) || primitive.radius <= 0 || primitive.radius > 256) throw new Error(`model.primitives[${index}].radius is invalid`)
    if (primitive.type === 'cylinder' && (!Number.isFinite(primitive.height) || primitive.height <= 0 || primitive.height > 512)) throw new Error(`model.primitives[${index}].height is invalid`)
  } else if (primitive.type === 'extrude') {
    if (!Array.isArray(primitive.profile) || primitive.profile.length < 3 || primitive.profile.length > 128) throw new Error(`model.primitives[${index}].profile is invalid`)
    primitive.profile.forEach((point) => assertFiniteVector(point, `model.primitives[${index}].profile`, 2))
    if (!Number.isFinite(primitive.depth) || primitive.depth <= 0 || primitive.depth > 512) throw new Error(`model.primitives[${index}].depth is invalid`)
  } else if (primitive.type === 'tube') {
    if (!Array.isArray(primitive.path) || primitive.path.length < 2 || primitive.path.length > 64) throw new Error(`model.primitives[${index}].path is invalid`)
    primitive.path.forEach((point) => assertFiniteVector(point, `model.primitives[${index}].path`, 3))
    if (!Number.isFinite(primitive.radius) || primitive.radius <= 0 || primitive.radius > 256) throw new Error(`model.primitives[${index}].radius is invalid`)
  } else {
    throw new Error(`model.primitives[${index}].type is invalid`)
  }
}

function assertFiniteVector(value: unknown, label: string, length: number): void {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 1024)) {
    throw new Error(`${label} is invalid`)
  }
}

function topologicalBones<T extends {id: string; parent?: string}>(bones: T[]): T[] {
  return topological(bones, 'bone')
}

function topologicalPrimitives(primitives: AdvancedAssetPrimitive[]): AdvancedAssetPrimitive[] {
  return topological(primitives, 'primitive')
}

function topological<T extends {id: string; parent?: string}>(items: T[], label: string): T[] {
  const remaining = [...items]
  const result: T[] = []
  const known = new Set<string>()
  while (remaining.length) {
    const index = remaining.findIndex((item) => !item.parent || known.has(item.parent) || !items.some((candidate) => candidate.id === item.parent))
    if (index < 0) throw new Error(`Cyclic ${label} hierarchy`)
    const [item] = remaining.splice(index, 1)
    result.push(item)
    known.add(item.id)
  }
  return result
}

function sampleCatmullRom(points: BlockbenchVector3[], segments: number, closed: boolean): BlockbenchVector3[] {
  const samples: BlockbenchVector3[] = []
  const intervalCount = closed ? points.length : points.length - 1
  for (let interval = 0; interval < intervalCount; interval += 1) {
    const at = (index: number): BlockbenchVector3 => closed
      ? points[(index + points.length) % points.length]
      : points[Math.max(0, Math.min(points.length - 1, index))]
    const p0 = at(interval - 1), p1 = at(interval), p2 = at(interval + 1), p3 = at(interval + 2)
    for (let step = 0; step < segments; step += 1) {
      const t = step / segments, t2 = t * t, t3 = t2 * t
      samples.push([0, 1, 2].map((axis) => 0.5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t
        + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2
        + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3)) as BlockbenchVector3)
    }
  }
  if (!closed) samples.push(points.at(-1)!)
  return samples
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex')
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortObject(item)]))
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'asset'
}

function add(left: BlockbenchVector3, right: BlockbenchVector3): BlockbenchVector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}
function subtract(left: BlockbenchVector3, right: BlockbenchVector3): BlockbenchVector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}
function scale(vector: BlockbenchVector3, factor: number): BlockbenchVector3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}
function cross(left: BlockbenchVector3, right: BlockbenchVector3): BlockbenchVector3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]]
}
function normalize(vector: BlockbenchVector3): BlockbenchVector3 {
  const length = Math.hypot(...vector) || 1
  return scale(vector, 1 / length)
}
function roundVector(vector: BlockbenchVector3): BlockbenchVector3 {
  return vector.map((value) => Number(value.toFixed(5))) as BlockbenchVector3
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum))
}
