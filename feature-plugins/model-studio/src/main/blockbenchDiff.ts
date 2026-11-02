import type {
  BlockbenchAction,
  BlockbenchDiffEntry,
  BlockbenchProjectDiff,
  BlockbenchProjectState
} from "../../../../src/shared/blockbench"

type DiffCategory = BlockbenchDiffEntry['category']

export function diffBlockbenchProjects(before: BlockbenchProjectState, after: BlockbenchProjectState): BlockbenchProjectDiff {
  const entries: BlockbenchDiffEntry[] = []
  compare('cube', before.cubes, after.cubes, entries)
  compare('group', before.groups, after.groups, entries)
  compare('mesh', before.meshes, after.meshes, entries)
  compare('texture', before.textures, after.textures, entries)
  compare('animation', before.animations, after.animations, entries)
  compare('armature', before.armatures ?? [], after.armatures ?? [], entries)
  compare('bone', before.bones ?? [], after.bones ?? [], entries)
  compare('locator', before.locators ?? [], after.locators ?? [], entries)
  compare('ik-target', before.ikTargets ?? [], after.ikTargets ?? [], entries)
  return {
    revisionBefore: before.revision,
    revisionAfter: after.revision,
    entries,
    counts: {
      added: entries.filter((entry) => entry.change === 'added').length,
      removed: entries.filter((entry) => entry.change === 'removed').length,
      changed: entries.filter((entry) => entry.change === 'changed').length
    }
  }
}

export function describeBlockbenchActions(actions: BlockbenchAction[]): Array<{type: string; target: string; detail: string}> {
  return actions.map((action) => {
    switch (action.type) {
      case 'load-source-document': return {type: action.type, target: action.document.name, detail: `Import ${action.document.format} model with native codec`}
      case 'new-model': return {type: action.type, target: action.name, detail: `Create ${action.format} model`}
      case 'add-cube': return {type: action.type, target: action.name, detail: `Cube ${action.from.join(',')} to ${action.to.join(',')}`}
      case 'add-mesh': return {type: action.type, target: action.name, detail: `${Object.keys(action.vertices).length} vertices, ${action.faces.length} faces`}
      case 'update-mesh': return {type: action.type, target: action.meshName ?? action.meshUuid ?? 'mesh', detail: action.faces ? `Replace topology with ${action.faces.length} faces` : 'Update mesh transform or shading'}
      case 'paint-texture': return {type: action.type, target: action.textureName ?? action.textureUuid ?? 'texture', detail: `${action.rectangles?.length ?? 0} patches, ${action.strokes?.length ?? 0} strokes`}
      case 'set-vertex-weights': return {type: action.type, target: action.meshName ?? action.meshUuid ?? 'mesh', detail: `${Object.keys(action.weights).length} weighted vertices`}
      case 'add-keyframe': return {type: action.type, target: action.groupName ?? action.groupUuid ?? 'target', detail: `${action.channel} at ${action.time}s`}
      case 'delete-elements': return {type: action.type, target: `${action.elementUuids.length} elements`, detail: 'Delete selected elements'}
      case 'save-project':
      case 'save-texture':
      case 'export-model': return {type: action.type, target: action.relativePath, detail: 'Write project asset'}
      default: {
        const record = action as unknown as Record<string, unknown>
        const target = String(record.name ?? record.cubeName ?? record.groupName ?? record.meshName ?? record.elementUuid ?? record.type)
        return {type: action.type, target, detail: action.type.replaceAll('-', ' ')}
      }
    }
  })
}

function compare<T extends {uuid: string; name: string}>(category: DiffCategory, before: T[], after: T[], entries: BlockbenchDiffEntry[]): void {
  const previous = new Map(before.map((item) => [item.uuid, item]))
  const current = new Map(after.map((item) => [item.uuid, item]))
  for (const item of before) if (!current.has(item.uuid)) entries.push({category, change: 'removed', uuid: item.uuid, name: item.name, fields: []})
  for (const item of after) {
    const old = previous.get(item.uuid)
    if (!old) {
      entries.push({category, change: 'added', uuid: item.uuid, name: item.name, fields: []})
      continue
    }
    const fields = changedFields(old, item)
    if (fields.length) entries.push({category, change: 'changed', uuid: item.uuid, name: item.name, fields})
  }
}

function changedFields(before: object, after: object): string[] {
  const ignored = new Set(['uuid', 'selected', 'saved'])
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !ignored.has(key))
    .filter((key) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]))
    .sort()
}
