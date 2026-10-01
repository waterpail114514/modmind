import {createHash} from 'node:crypto'
import type {
  AssetIntentDiagnostic,
  AssetRefinementCandidate,
  AssetRefinementPart,
  AssetRefinementProgram
} from "../../../../src/shared/assetIntent"
import type {BlockbenchAction, BlockbenchProjectState, BlockbenchVector3} from "../../../../src/shared/blockbench"

const MAX_REFINEMENTS = 64
const MAX_KEYFRAMES = 120

export function compileAssetRefinement(input: unknown, state: BlockbenchProjectState): AssetRefinementCandidate {
  const program = normalizeRefinement(input)
  const diagnostics: AssetIntentDiagnostic[] = []
  const actions: BlockbenchAction[] = []
  const used = new Set<string>()

  if (program.metadata.sourceIntentHash && program.metadata.sourceIntentHash !== state.metadata?.intentHash) {
    diagnostics.push({
      severity: 'error',
      path: 'metadata.sourceIntentHash',
      message: 'The refinement source intent hash does not match the current Blockbench project'
    })
  }

  for (const [index, refinement] of program.parts.entries()) {
    if (used.has(refinement.id)) diagnostics.push({severity: 'error', path: `parts[${index}].id`, message: `Duplicate refinement part: ${refinement.id}`})
    used.add(refinement.id)
    const group = state.groups.find((candidate) => candidate.name === refinement.id)
    if (!group) {
      diagnostics.push({severity: 'error', path: `parts[${index}].id`, message: `Unknown Blockbench group: ${refinement.id}`})
      continue
    }
    const cubes = state.cubes.filter((cube) => cube.parentUuid === group.uuid)
    if (cubes.length !== 1) {
      diagnostics.push({severity: 'error', path: `parts[${index}].id`, message: `Refinement requires exactly one cube in group ${refinement.id}`})
      continue
    }
    const cube = cubes[0]
    const currentCenter = cube.from.map((value, axis) => (value + cube.to[axis]) / 2) as BlockbenchVector3
    const center = refinement.offset ?? currentCenter
    const size = refinement.size ?? cube.to.map((value, axis) => value - cube.from[axis]) as BlockbenchVector3
    if (size.some((value) => value <= 0 || value > 256)) diagnostics.push({severity: 'error', path: `parts[${index}].size`, message: 'Part dimensions must be greater than 0 and at most 256'})
    const from = center.map((value, axis) => value - size[axis] / 2) as BlockbenchVector3
    const to = center.map((value, axis) => value + size[axis] / 2) as BlockbenchVector3
    if ([...from, ...to].some((value) => value < -1024 || value > 1024)) diagnostics.push({severity: 'error', path: `parts[${index}].offset`, message: 'Refined part leaves the Blockbench coordinate range'})
    if (refinement.rotation?.some((value) => value < -360 || value > 360)) diagnostics.push({severity: 'error', path: `parts[${index}].rotation`, message: 'Part rotations must stay within -360 to 360 degrees'})
    if ((refinement.inflate ?? cube.inflate) < -64 || (refinement.inflate ?? cube.inflate) > 64) diagnostics.push({severity: 'error', path: `parts[${index}].inflate`, message: 'Part inflate must stay within -64 to 64'})
    if (refinement.offset || refinement.rotation) actions.push({
      type: 'update-group',
      groupUuid: group.uuid,
      ...(refinement.offset ? {origin: refinement.offset} : {}),
      ...(refinement.rotation ? {rotation: refinement.rotation} : {})
    })
    if (refinement.size || refinement.offset || refinement.inflate !== undefined) actions.push({
      type: 'update-cube',
      cubeUuid: cube.uuid,
      ...(refinement.size || refinement.offset ? {from, to} : {}),
      ...(refinement.offset ? {origin: refinement.offset} : {}),
      ...(refinement.inflate !== undefined ? {inflate: refinement.inflate} : {})
    })
  }

  if (program.animation) {
    if (!['modded_entity', 'bedrock', 'free'].includes(state.format.id)) diagnostics.push({severity: 'error', path: 'animation', message: `Format ${state.format.id} does not support editable animation tracks`})
    if (state.animations.some((animation) => animation.name === program.animation!.name)) diagnostics.push({severity: 'error', path: 'animation.name', message: 'Refinement animation names must be new and unique'})
    actions.push({type: 'add-animation', name: program.animation.name, length: program.animation.length, loop: program.animation.loop ?? 'loop', snapping: 20})
    for (const [trackIndex, track] of program.animation.tracks.entries()) {
      const group = state.groups.find((candidate) => candidate.name === track.part)
      if (!group) {
        diagnostics.push({severity: 'error', path: `animation.tracks[${trackIndex}].part`, message: `Unknown Blockbench group: ${track.part}`})
        continue
      }
      const times = new Set<number>()
      for (const keyframe of track.keyframes) {
        if (times.has(keyframe.time)) diagnostics.push({severity: 'error', path: `animation.tracks[${trackIndex}].keyframes`, message: `Duplicate keyframe time: ${keyframe.time}`})
        times.add(keyframe.time)
        if (keyframe.value.some((value) => value < -1024 || value > 1024)) diagnostics.push({severity: 'error', path: `animation.tracks[${trackIndex}].keyframes`, message: 'Keyframe values must stay within -1024 to 1024'})
      }
      for (const keyframe of track.keyframes) actions.push({
        type: 'add-keyframe', animationName: program.animation.name, groupName: group.name,
        channel: track.channel, time: keyframe.time, value: keyframe.value, interpolation: keyframe.interpolation ?? 'linear'
      })
    }
  }

  const hash = createHash('sha256').update(JSON.stringify(program)).digest('hex')
  const summary: AssetRefinementCandidate['summary'] = {
    name: program.metadata.name,
    format: state.format.id,
    parts: program.parts.length,
    animations: program.animation ? 1 : 0
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return {candidateVersion: 1, intentVersion: 1, intentHash: hash, baseRevision: state.revision, summary, actions: [], diagnostics, sourceMetadata: state.metadata}
  actions.push({type: 'set-asset-metadata', metadata: {source: 'REFINED', intentHash: hash, ...(state.metadata?.intentHash ? {refinedFrom: state.metadata.intentHash} : {})}})
  return {candidateVersion: 1, intentVersion: 1, intentHash: hash, baseRevision: state.revision, summary, actions, diagnostics, sourceMetadata: state.metadata}
}

function normalizeRefinement(input: unknown): AssetRefinementProgram {
  if (!isRecord(input) || input.version !== 1 || !isRecord(input.metadata) || typeof input.metadata.name !== 'string' || !input.metadata.name.trim()) throw new Error('Asset Refinement Program metadata is invalid')
  if (input.metadata.name.trim().length > 64 || /[\u0000-\u001f/\\]/.test(input.metadata.name)) throw new Error('Asset Refinement Program metadata name is invalid')
  if (input.metadata.sourceIntentHash !== undefined && (typeof input.metadata.sourceIntentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.metadata.sourceIntentHash))) throw new Error('metadata.sourceIntentHash must be a SHA-256 hash')
  if (!Array.isArray(input.parts) || input.parts.length > MAX_REFINEMENTS || (input.parts.length === 0 && input.animation === undefined)) throw new Error(`parts must contain 0-${MAX_REFINEMENTS} entries and the refinement cannot be empty`)
  const parts = input.parts.map((value, index) => normalizePart(value, index))
  const program: AssetRefinementProgram = {version: 1, metadata: {name: input.metadata.name.trim(), ...(typeof input.metadata.sourceIntentHash === 'string' ? {sourceIntentHash: input.metadata.sourceIntentHash} : {})}, parts}
  if (input.animation !== undefined) program.animation = normalizeAnimation(input.animation)
  return program
}

function normalizePart(value: unknown, index: number): AssetRefinementPart {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) throw new Error(`parts[${index}].id is required`)
  const result: AssetRefinementPart = {id: value.id.trim().toLowerCase()}
  if (value.size !== undefined) result.size = vector(value.size, `parts[${index}].size`)
  if (value.offset !== undefined) result.offset = vector(value.offset, `parts[${index}].offset`)
  if (value.rotation !== undefined) result.rotation = vector(value.rotation, `parts[${index}].rotation`)
  if (value.inflate !== undefined) result.inflate = finite(value.inflate, `parts[${index}].inflate`)
  if (Object.keys(result).length === 1) throw new Error(`parts[${index}] has no changes`)
  return result
}

function normalizeAnimation(value: unknown): NonNullable<AssetRefinementProgram['animation']> {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.length !== 'number' || !Number.isFinite(value.length) || value.length <= 0 || value.length > 3600 || !Array.isArray(value.tracks)) throw new Error('Refinement animation is invalid')
  if (value.name.trim().length > 64 || /[\u0000-\u001f/\\]/.test(value.name)) throw new Error('Refinement animation name is invalid')
  if (value.tracks.length > MAX_KEYFRAMES) throw new Error(`Refinement animation may contain at most ${MAX_KEYFRAMES} tracks`)
  const count = value.tracks.reduce((total, track) => total + (isRecord(track) && Array.isArray(track.keyframes) ? track.keyframes.length : 0), 0)
  if (count > MAX_KEYFRAMES) throw new Error(`Refinement animation may contain at most ${MAX_KEYFRAMES} keyframes`)
  return {name: value.name.trim(), length: value.length, loop: value.loop === 'once' || value.loop === 'hold' ? value.loop : 'loop', tracks: value.tracks.map((track, index) => {
    if (!isRecord(track) || typeof track.part !== 'string' || !track.part.trim() || !['rotation', 'position', 'scale'].includes(String(track.channel)) || !Array.isArray(track.keyframes)) throw new Error(`animation.tracks[${index}] is invalid`)
    return {part: track.part.trim().toLowerCase(), channel: track.channel as 'rotation' | 'position' | 'scale', keyframes: track.keyframes.map((keyframe) => {
      if (!isRecord(keyframe) || typeof keyframe.time !== 'number' || !Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > value.length) throw new Error(`animation.tracks[${index}] keyframe time is invalid`)
      return {time: keyframe.time, value: vector(keyframe.value, `animation.tracks[${index}].value`), interpolation: ['linear', 'catmullrom', 'step', 'bezier'].includes(String(keyframe.interpolation)) ? keyframe.interpolation as 'linear' | 'catmullrom' | 'step' | 'bezier' : 'linear'}
    })}
  })}
}

function vector(value: unknown, path: string): BlockbenchVector3 { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} must contain three numbers`); return value.map((item) => finite(item, path)) as BlockbenchVector3 }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be finite`); return value }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
