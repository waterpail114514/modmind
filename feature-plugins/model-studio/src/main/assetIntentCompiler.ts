import { createHash } from 'node:crypto'
import {
  ASSET_INTENT_DOMAINS,
  ASSET_INTENT_FORMATS,
  ASSET_INTENT_PALETTES,
  ASSET_INTENT_PART_KINDS,
  ASSET_INTENT_TEXTURES,
  ASSET_INTENT_VERSION,
  type AssetIntentCandidate,
  type AssetIntentDiagnostic,
  type AssetIntentPart,
  type AssetIntentProgram
} from "../../../../src/shared/assetIntent"
import type { BlockbenchAction, BlockbenchVector3 } from "../../../../src/shared/blockbench"

const PALETTE_COLORS: Record<(typeof ASSET_INTENT_PALETTES)[number], {base: string; shade: string; accent: string}> = {
  natural: {base: '#8b6f47ff', shade: '#59432bff', accent: '#d9bf8bff'},
  ember: {base: '#8f3d2eff', shade: '#4b1f1aff', accent: '#f0b24bff'},
  ocean: {base: '#286b83ff', shade: '#123947ff', accent: '#86d1d5ff'},
  noir: {base: '#343842ff', shade: '#16181eff', accent: '#aeb7c8ff'},
  metal: {base: '#7e8790ff', shade: '#424950ff', accent: '#d8e0e7ff'},
  gold: {base: '#b8862fff', shade: '#664817ff', accent: '#f1d17aff'}
}

const MAX_PARTS = 64
const MAX_KEYFRAMES = 120
const MAX_GENERATED_ACTIONS = 500
const ANIMATION_FORMATS = new Set(['modded_entity', 'bedrock', 'free'])

export function compileAssetIntent(input: unknown): AssetIntentCandidate {
  const program = normalizeProgram(input)
  const diagnostics: AssetIntentDiagnostic[] = []
  const ids = new Set<string>()
  for (const [index, part] of program.model.parts.entries()) {
    if (ids.has(part.id)) diagnostics.push({severity: 'error', path: `model.parts[${index}].id`, message: `Duplicate part id: ${part.id}`})
    ids.add(part.id)
  }
  for (const [index, part] of program.model.parts.entries()) {
    if (part.parent && !ids.has(part.parent)) diagnostics.push({severity: 'error', path: `model.parts[${index}].parent`, message: `Unknown parent part: ${part.parent}`})
    if (part.parent === part.id) diagnostics.push({severity: 'error', path: `model.parts[${index}].parent`, message: 'A part cannot parent itself'})
    if (part.size.some((value) => value <= 0 || value > 256)) diagnostics.push({severity: 'error', path: `model.parts[${index}].size`, message: 'Part dimensions must be greater than 0 and at most 256'})
    if ((part.offset ?? [0, 0, 0]).some((value, axis) => value - part.size[axis] / 2 < -1024 || value + part.size[axis] / 2 > 1024)) {
      diagnostics.push({severity: 'error', path: `model.parts[${index}].offset`, message: 'Part bounds must stay within the Blockbench coordinate range (-1024 to 1024)'})
    }
    if ((part.rotation ?? [0, 0, 0]).some((value) => value < -360 || value > 360)) {
      diagnostics.push({severity: 'error', path: `model.parts[${index}].rotation`, message: 'Part rotations must stay within -360 to 360 degrees'})
    }
    if ((part.inflate ?? 0) < -64 || (part.inflate ?? 0) > 64) {
      diagnostics.push({severity: 'error', path: `model.parts[${index}].inflate`, message: 'Part inflate must stay within -64 to 64'})
    }
  }
  for (const part of program.model.parts) {
    const visited = new Set<string>()
    let current: string | undefined = part.id
    while (current) {
      if (visited.has(current)) {
        diagnostics.push({severity: 'error', path: `model.parts.${part.id}`, message: 'Part hierarchy contains a cycle'})
        break
      }
      visited.add(current)
      current = program.model.parts.find((candidate) => candidate.id === current)?.parent
    }
  }
  const expandedParts = expandParts(program.model.parts, program.model.symmetry === 'bilateral')
  const expandedIds = new Set<string>()
  for (const part of expandedParts) {
    if (expandedIds.has(part.id)) {
      diagnostics.push({severity: 'error', path: 'model.parts', message: `Bilateral expansion creates a duplicate part id: ${part.id}`})
    }
    expandedIds.add(part.id)
  }
  if (program.animation) {
    if (!ANIMATION_FORMATS.has(program.model.format)) {
      diagnostics.push({severity: 'error', path: 'animation', message: `Format ${program.model.format} does not support editable animation tracks`})
    }
    if (program.animation.length > 3600) {
      diagnostics.push({severity: 'error', path: 'animation.length', message: 'Animation length must not exceed 3600 seconds'})
    }
    const animationParts = new Set(program.model.parts.map((part) => part.id))
    for (const [index, track] of program.animation.tracks.entries()) {
      if (!animationParts.has(track.part)) diagnostics.push({severity: 'error', path: `animation.tracks[${index}].part`, message: `Unknown animation target: ${track.part}`})
      const times = new Set<number>()
      for (const keyframe of track.keyframes) {
        if (times.has(keyframe.time)) diagnostics.push({severity: 'error', path: `animation.tracks[${index}].keyframes`, message: `Duplicate keyframe time: ${keyframe.time}`})
        times.add(keyframe.time)
        if (keyframe.time > program.animation.length) diagnostics.push({severity: 'error', path: `animation.tracks[${index}].keyframes`, message: `Keyframe time ${keyframe.time} exceeds animation length`})
        if (keyframe.value.some((value) => value < -1024 || value > 1024)) diagnostics.push({severity: 'error', path: `animation.tracks[${index}].keyframes`, message: 'Keyframe values must stay within -1024 to 1024'})
      }
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return {
      candidateVersion: 1,
      intentVersion: ASSET_INTENT_VERSION,
      intentHash: hashProgram(program),
      summary: summarize(program),
      actions: [],
      diagnostics
    }
  }

  const palette = PALETTE_COLORS[program.appearance?.palette ?? 'natural']
  const textureName = `${slug(program.metadata.name)}_atlas`
  const actions: BlockbenchAction[] = [
    {
      type: 'new-model', format: program.model.format, name: program.metadata.name,
      textureWidth: program.model.textureWidth ?? 64, textureHeight: program.model.textureHeight ?? 64
    },
    {
      type: 'create-texture', name: textureName, width: program.model.textureWidth ?? 64,
      height: program.model.textureHeight ?? 64, fill: palette.base,
      rectangles: textureRectangles(program, palette)
    }
  ]
  const expanded = expandedParts
  const groups = new Set<string>()
  for (const part of expanded) {
    if (part.parent && !groups.has(part.parent)) continue
    const center = part.offset ?? [0, 0, 0]
    const groupAction: BlockbenchAction = {
      type: 'add-group', name: part.id, origin: center, rotation: part.rotation ?? [0, 0, 0],
      ...(part.parent ? {parentGroupName: part.parent} : {})
    }
    actions.push(groupAction)
    groups.add(part.id)
    const size = part.size
    const from: BlockbenchVector3 = [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2]
    const to: BlockbenchVector3 = [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2]
    actions.push({type: 'add-cube', name: `${part.id}_volume`, from, to, origin: center, rotation: [0, 0, 0], inflate: part.inflate ?? 0, parentGroupName: part.id, textureName})
  }
  if (program.animation) {
    actions.push({type: 'add-animation', name: program.animation.name, length: program.animation.length, loop: program.animation.loop ?? 'loop', snapping: 20})
    for (const track of expandAnimationTracks(program)) {
      for (const keyframe of track.keyframes) {
        actions.push({type: 'add-keyframe', animationName: program.animation.name, groupName: track.part, channel: track.channel, time: keyframe.time, value: keyframe.value, interpolation: keyframe.interpolation ?? 'linear'})
      }
    }
  }
  if (actions.length > MAX_GENERATED_ACTIONS) {
    diagnostics.push({severity: 'error', path: 'program', message: `Compiled asset exceeds the ${MAX_GENERATED_ACTIONS}-action safety limit`})
    return {candidateVersion: 1, intentVersion: ASSET_INTENT_VERSION, intentHash: hashProgram(program), summary: summarize(program), actions: [], diagnostics}
  }
  return {candidateVersion: 1, intentVersion: ASSET_INTENT_VERSION, intentHash: hashProgram(program), summary: {...summarize(program), parts: expanded.length, mirroredParts: Math.max(0, expanded.length - program.model.parts.length)}, actions, diagnostics}
}

function normalizeProgram(input: unknown): AssetIntentProgram {
  if (!isRecord(input)) throw new Error('Asset Intent Program must be an object')
  if (input.version !== ASSET_INTENT_VERSION) throw new Error(`Unsupported Asset Intent Program version: ${String(input.version)}`)
  const metadata = input.metadata
  const model = input.model
  if (!isRecord(metadata) || typeof metadata.name !== 'string' || !metadata.name.trim()) throw new Error('metadata.name is required')
  if (metadata.name.trim().length > 64 || /[\u0000-\u001f/\\]/.test(metadata.name)) throw new Error('metadata.name is invalid')
  if (!isRecord(model) || typeof model.format !== 'string' || !ASSET_INTENT_FORMATS.includes(model.format as never)) throw new Error('model.format is invalid')
  if (!Array.isArray(model.parts) || model.parts.length < 1 || model.parts.length > MAX_PARTS) throw new Error(`model.parts must contain 1-${MAX_PARTS} parts`)
  if (isRecord(input.appearance) && input.appearance.seed !== undefined
    && (typeof input.appearance.seed !== 'string' || input.appearance.seed.length > 128)) {
    throw new Error('appearance.seed is invalid')
  }
  const parts = model.parts.map((value, index) => normalizePart(value, index))
  const format = model.format as AssetIntentProgram['model']['format']
  const program: AssetIntentProgram = {
    version: ASSET_INTENT_VERSION,
    metadata: {
      name: metadata.name.trim(),
      quality: metadata.quality === undefined ? 'essential' : assertEnum(metadata.quality, ['essential', 'hero'] as const, `metadata.quality`),
      domain: metadata.domain === undefined ? 'organism' : assertEnum(metadata.domain, ASSET_INTENT_DOMAINS, 'metadata.domain')
    },
    model: {
      format,
      textureWidth: normalizeTextureSize(model.textureWidth, 'model.textureWidth'),
      textureHeight: normalizeTextureSize(model.textureHeight, 'model.textureHeight'),
      symmetry: model.symmetry === undefined ? 'asymmetric' : assertEnum(model.symmetry, ['bilateral', 'asymmetric'] as const, 'model.symmetry'),
      parts
    },
    appearance: {
      palette: isRecord(input.appearance) && input.appearance.palette !== undefined
        ? assertEnum(input.appearance.palette, ASSET_INTENT_PALETTES, 'appearance.palette') : 'natural',
      texture: isRecord(input.appearance) && input.appearance.texture !== undefined
        ? assertEnum(input.appearance.texture, ASSET_INTENT_TEXTURES, 'appearance.texture') : 'mottle',
      seed: isRecord(input.appearance) && typeof input.appearance.seed === 'string' ? input.appearance.seed : 'auto'
    }
  }
  if (input.animation !== undefined) program.animation = normalizeAnimation(input.animation, parts)
  return program
}

function normalizePart(value: unknown, index: number): AssetIntentPart {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) throw new Error(`model.parts[${index}].id is required`)
  if (typeof value.kind !== 'string' || !ASSET_INTENT_PART_KINDS.includes(value.kind as never)) throw new Error(`model.parts[${index}].kind is invalid`)
  return {
    id: slug(value.id), kind: value.kind as AssetIntentPart['kind'], parent: typeof value.parent === 'string' ? slug(value.parent) : undefined,
    side: value.side === undefined ? 'center' : assertEnum(value.side, ['center', 'left', 'right'] as const, `model.parts[${index}].side`),
    size: vector(value.size, `model.parts[${index}].size`), offset: value.offset === undefined ? [0, 0, 0] : vector(value.offset, `model.parts[${index}].offset`),
    rotation: value.rotation === undefined ? [0, 0, 0] : vector(value.rotation, `model.parts[${index}].rotation`),
    inflate: value.inflate === undefined ? 0 : finiteNumber(value.inflate, `model.parts[${index}].inflate`)
  }
}

function normalizeAnimation(value: unknown, parts: AssetIntentPart[]): NonNullable<AssetIntentProgram['animation']> {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.length !== 'number' || !Number.isFinite(value.length) || value.length <= 0) throw new Error('animation.name and positive animation.length are required')
  if (value.name.trim().length > 64 || /[\u0000-\u001f/\\]/.test(value.name)) throw new Error('animation.name is invalid')
  if (!Array.isArray(value.tracks) || value.tracks.length > MAX_KEYFRAMES) throw new Error(`animation.tracks must contain at most ${MAX_KEYFRAMES} tracks`)
  const keyframeCount = value.tracks.reduce((count, track) => count + (isRecord(track) && Array.isArray(track.keyframes) ? track.keyframes.length : 0), 0)
  if (keyframeCount > MAX_KEYFRAMES) throw new Error(`animation may contain at most ${MAX_KEYFRAMES} source keyframes`)
  return {
    name: value.name.trim(), length: value.length, loop: value.loop === undefined ? 'loop' : assertEnum(value.loop, ['once', 'loop', 'hold'] as const, 'animation.loop'),
    tracks: value.tracks.map((track, index) => {
      if (!isRecord(track) || typeof track.part !== 'string' || typeof track.channel !== 'string' || !['rotation', 'position', 'scale'].includes(track.channel) || !Array.isArray(track.keyframes)) throw new Error(`animation.tracks[${index}] is invalid`)
      return {part: slug(track.part), channel: track.channel as 'rotation' | 'position' | 'scale', keyframes: track.keyframes.map((keyframe) => {
        if (!isRecord(keyframe) || typeof keyframe.time !== 'number' || !Number.isFinite(keyframe.time) || keyframe.time < 0) throw new Error(`animation.tracks[${index}] contains an invalid keyframe`)
        return {time: keyframe.time, value: vector(keyframe.value, `animation.tracks[${index}].value`), interpolation: keyframe.interpolation === undefined ? 'linear' : assertEnum(keyframe.interpolation, ['linear', 'catmullrom', 'step', 'bezier'] as const, 'animation interpolation')}
      })}
    })
  }
}

function expandParts(parts: AssetIntentPart[], bilateral: boolean): AssetIntentPart[] {
  const expanded: AssetIntentPart[] = []
  for (const part of parts) {
    if (!bilateral || part.side === 'center') expanded.push(part)
    else {
      const left = {...part, id: `${part.id}_left`, parent: expandedParentId(part.parent, 'left', parts), offset: mirrorVector(part.offset), rotation: mirrorRotation(part.rotation), side: 'left' as const}
      const right = {...part, id: `${part.id}_right`, parent: expandedParentId(part.parent, 'right', parts), side: 'right' as const}
      expanded.push(left, right)
    }
  }
  const ordered: AssetIntentPart[] = []
  const pending = [...expanded]
  while (pending.length) {
    const nextIndex = pending.findIndex((part) => !part.parent || ordered.some((parent) => parent.id === part.parent))
    if (nextIndex < 0) return expanded
    ordered.push(pending.splice(nextIndex, 1)[0])
  }
  return ordered
}

function expandedParentId(id: string | undefined, side: 'left' | 'right', parts: AssetIntentPart[]): string | undefined {
  if (!id) return undefined
  const parent = parts.find((candidate) => candidate.id === id)
  return parent && parent.side !== 'center' ? `${id}_${side}` : id
}
function mirrorVector(vectorValue: BlockbenchVector3 | undefined): BlockbenchVector3 | undefined { return vectorValue ? cleanVector([-vectorValue[0], vectorValue[1], vectorValue[2]]) : vectorValue }
function mirrorRotation(vectorValue: BlockbenchVector3 | undefined): BlockbenchVector3 | undefined { return vectorValue ? cleanVector([vectorValue[0], -vectorValue[1], -vectorValue[2]]) : vectorValue }
function cleanVector(value: BlockbenchVector3): BlockbenchVector3 { return value.map((item) => Object.is(item, -0) ? 0 : item) as BlockbenchVector3 }

function expandAnimationTracks(program: AssetIntentProgram): NonNullable<AssetIntentProgram['animation']>['tracks'] {
  if (!program.animation) return []
  const bilateral = program.model.symmetry === 'bilateral'
  return program.animation.tracks.flatMap((track) => {
    const part = program.model.parts.find((candidate) => candidate.id === track.part)
    if (!bilateral || !part || part.side === 'center') return [track]
    return [
      {
        ...track,
        part: `${track.part}_left`,
        keyframes: track.keyframes.map((keyframe) => ({
          ...keyframe,
          value: track.channel === 'rotation'
            ? mirrorRotation(keyframe.value) as BlockbenchVector3
            : track.channel === 'position'
              ? mirrorVector(keyframe.value) as BlockbenchVector3
              : keyframe.value
        }))
      },
      {...track, part: `${track.part}_right`}
    ]
  })
}

function textureRectangles(program: AssetIntentProgram, palette: {base: string; shade: string; accent: string}): Array<{x: number; y: number; width: number; height: number; color: string}> {
  const width = program.model.textureWidth ?? 64
  const height = program.model.textureHeight ?? 64
  const seed = hashProgram(program)
  const rectangles = [{x: 0, y: Math.max(0, Math.floor(height * 0.55)), width, height: Math.max(1, Math.floor(height * 0.15)), color: palette.shade}]
  for (let index = 0; index < Math.min(12, program.model.parts.length); index += 1) {
    const hash = Number.parseInt(seed.slice((index * 2) % seed.length, (index * 2) % seed.length + 2), 16)
    const x = hash % Math.max(1, width - 3)
    const y = (hash * 7 + index * 3) % Math.max(1, height - 2)
    rectangles.push({x, y, width: Math.min(3, width - x), height: Math.min(2, height - y), color: index % 3 === 0 ? palette.accent : palette.shade})
  }
  return rectangles
}

function summarize(program: AssetIntentProgram): AssetIntentCandidate['summary'] {
  return {name: program.metadata.name, format: program.model.format, quality: program.metadata.quality ?? 'essential', domain: program.metadata.domain ?? 'organism', parts: program.model.parts.length, mirroredParts: 0, textures: 1, animations: program.animation ? 1 : 0}
}
function hashProgram(program: AssetIntentProgram): string { return createHash('sha256').update(JSON.stringify(program)).digest('hex') }
function normalizeTextureSize(value: unknown, path: string): number {
  if (value === undefined) return 64
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1024) throw new Error(`${path} must be an integer from 1 to 1024`)
  return value
}
function vector(value: unknown, path: string): BlockbenchVector3 { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} must contain three numbers`); return value.map((item) => finiteNumber(item, path)) as BlockbenchVector3 }
function finiteNumber(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be finite`); return value }
function assertEnum<T extends string>(value: unknown, values: readonly T[], path: string): T { if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${path} is invalid`); return value as T }
function slug(value: string): string { const result = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, ''); if (!result) throw new Error('Identifiers must contain letters or numbers'); return result.slice(0, 64) }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
