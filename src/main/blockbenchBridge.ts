import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import {
  BLOCKBENCH_FORMATS,
  BLOCKBENCH_VIEW_PRESETS,
  type BlockbenchAction,
  type BlockbenchActionBatchResult,
  type BlockbenchActionResult,
  type BlockbenchAssetMetadata,
  type BlockbenchAssetSaveRequest,
  type BlockbenchAssetSaveResult,
  type BlockbenchBounds,
  type BlockbenchBridgeStatus,
  type BlockbenchCaptureRequest,
  type BlockbenchCaptureResult,
  type BlockbenchCommand,
  type BlockbenchFace,
  type BlockbenchHistoryEntry,
  type BlockbenchProjectDiff,
  type BlockbenchProjectState,
  type BlockbenchValidationFinding,
  type BlockbenchValidationResult,
  type BlockbenchValidationSeverity,
  type BlockbenchViewPreset,
  type BlockbenchVector3
} from '../shared/blockbench'
import {diffBlockbenchProjects} from './blockbenchDiff'

export interface BlockbenchBridgeOptions {
  window: BrowserWindow
  entryPath: string
  getProjectRoot: () => string | null
  partition?: string
}

type StatusListener = (status: BlockbenchBridgeStatus) => void

interface PageActionResult {
  message: string
  data?: Record<string, unknown>
  content?: string
  captures?: Array<{ view: string; width: number; height: number; dataUrl: string }>
}

interface BlockbenchCandidateSession {
  execution: BlockbenchActionBatchResult
  createdProjectUuids: string[]
  restoreProjectUuid: string | null
}

interface StoredBlockbenchCheckpoint {
  entry: BlockbenchHistoryEntry
  token: string
}

const EMPTY_PROJECT_REVISION = `sha256:${createHash('sha256').update(JSON.stringify({ project: null })).digest('hex')}`

const PAGE_DISPATCHER = String.raw`async function dispatchBlockbenchAction(action) {
  const root = globalThis;
  const BlockbenchApi = typeof Blockbench !== 'undefined' ? Blockbench : root.Blockbench;
  const FormatsApi = typeof Formats !== 'undefined' ? Formats : root.Formats;
  const CubeApi = typeof Cube !== 'undefined' ? Cube : root.Cube;
  const TextureApi = typeof Texture !== 'undefined' ? Texture : root.Texture;
  const GroupApi = typeof Group !== 'undefined' ? Group : root.Group;
  const MeshApi = typeof Mesh !== 'undefined' ? Mesh : root.Mesh;
  const MeshFaceApi = typeof MeshFace !== 'undefined' ? MeshFace : root.MeshFace;
  const ArmatureApi = typeof Armature !== 'undefined' ? Armature : root.Armature;
  const ArmatureBoneApi = typeof ArmatureBone !== 'undefined' ? ArmatureBone : root.ArmatureBone;
  const LocatorApi = typeof Locator !== 'undefined' ? Locator : root.Locator;
  const NullObjectApi = typeof NullObject !== 'undefined' ? NullObject : root.NullObject;
  const AnimationApi = typeof Animation !== 'undefined' ? Animation : root.Animation;
  const ModelProjectApi = typeof ModelProject !== 'undefined' ? ModelProject : root.ModelProject;
  const OutlinerApi = typeof Outliner !== 'undefined' ? Outliner : root.Outliner;
  const UndoApi = typeof Undo !== 'undefined' ? Undo : root.Undo;
  const CanvasApi = typeof Canvas !== 'undefined' ? Canvas : root.Canvas;
  const ScreencamApi = typeof Screencam !== 'undefined' ? Screencam : root.Screencam;
  const DefaultCameraPresetsApi = typeof DefaultCameraPresets !== 'undefined' ? DefaultCameraPresets : root.DefaultCameraPresets;
  const ThreeApi = root.THREE;
  const CodecsApi = typeof Codecs !== 'undefined' ? Codecs : root.Codecs;
  const BarItemsApi = typeof BarItems !== 'undefined' ? BarItems : root.BarItems;
  const ModesApi = typeof Modes !== 'undefined' ? Modes : root.Modes;
  const ProjectApi = typeof Project !== 'undefined' ? Project : root.Project;
  const newProjectApi = typeof newProject !== 'undefined' ? newProject : root.newProject;
  const setupProjectApi = typeof setupProject !== 'undefined' ? setupProject : root.setupProject;

  if (!BlockbenchApi || !FormatsApi || !CubeApi || !TextureApi) {
    throw new Error('Blockbench API is not ready');
  }

  const updateCanvas = (elements) => {
    if (CanvasApi && typeof CanvasApi.updateView === 'function') {
      CanvasApi.updateView({
        elements,
        element_aspects: {geometry: true, uv: true, faces: true},
        selection: true
      });
    } else if (CanvasApi && typeof CanvasApi.updateAll === 'function') {
      CanvasApi.updateAll();
    }
  };
  const findGroup = (uuid, name) => {
    const groups = GroupApi && Array.isArray(GroupApi.all) ? GroupApi.all : [];
    return groups.find((group) => uuid ? group.uuid === uuid : group.name === name);
  };
  const allNodes = () => {
    const nodes = OutlinerApi && Array.isArray(OutlinerApi.nodes) ? OutlinerApi.nodes : [];
    const elements = OutlinerApi && Array.isArray(OutlinerApi.elements) ? OutlinerApi.elements : [];
    const groups = GroupApi && Array.isArray(GroupApi.all) ? GroupApi.all : [];
    return [...new Set([...nodes, ...groups, ...elements])];
  };
  const findNode = (uuid, name, type) => allNodes().find((node) => node
    && (!type || node.type === type)
    && (uuid ? node.uuid === uuid : node.name === name));
  const findTexture = (uuid, name) => {
    const textures = TextureApi && Array.isArray(TextureApi.all) ? TextureApi.all : [];
    return textures.find((texture) => uuid ? texture.uuid === uuid : texture.name === name);
  };
  const vector3 = (value) => [0, 1, 2].map((index) => {
    const item = Array.isArray(value) ? Number(value[index]) : 0;
    return Number.isFinite(item) ? item : 0;
  });
  const parentUuid = (element) => element && element.parent && typeof element.parent === 'object'
    ? String(element.parent.uuid || '') || undefined
    : undefined;
  const contentHash = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489917);
    }
    return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
  };
  const keyframeSnapshot = (keyframes) => Array.isArray(keyframes) ? keyframes.map((keyframe) => ({
    uuid: String(keyframe && keyframe.uuid || ''),
    channel: String(keyframe && keyframe.channel || ''),
    time: Number(keyframe && keyframe.time || 0),
    interpolation: String(keyframe && keyframe.interpolation || 'linear'),
    dataPoints: keyframe && Array.isArray(keyframe.data_points) ? keyframe.data_points.map((point) => ({
      x: point && (typeof point.x === 'string' || typeof point.x === 'number') ? point.x : 0,
      y: point && (typeof point.y === 'string' || typeof point.y === 'number') ? point.y : 0,
      z: point && (typeof point.z === 'string' || typeof point.z === 'number') ? point.z : 0
    })) : []
  })) : [];

  if (action.type === 'active-project') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    return {message: 'Active project inspected', data: {projectUuid: activeProject ? String(activeProject.uuid || '') : ''}};
  }

  if (action.type === 'set-asset-metadata') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (!activeProject) throw new Error('No Blockbench project is open');
    if (!activeProject.unhandled_root_fields || typeof activeProject.unhandled_root_fields !== 'object') activeProject.unhandled_root_fields = {};
    activeProject.unhandled_root_fields.modmind_asset = action.metadata;
    activeProject.saved = false;
    return {message: 'Asset metadata updated', data: {source: action.metadata.source, intentHash: action.metadata.intentHash || ''}};
  }

  if (action.type === 'discard-project') {
    const projects = ModelProjectApi && Array.isArray(ModelProjectApi.all) ? ModelProjectApi.all : [];
    const project = projects.find((candidate) => candidate && candidate.uuid === action.projectUuid);
    if (project && typeof project.close === 'function') await project.close(true);
    const restore = projects.find((candidate) => candidate && candidate.uuid === action.restoreProjectUuid);
    if (restore && typeof restore.select === 'function') restore.select();
    return {message: project ? 'Candidate project discarded' : 'Candidate project was already closed'};
  }

  if (action.type === 'snapshot-project') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (!activeProject || !CodecsApi || !CodecsApi.project || typeof CodecsApi.project.compile !== 'function') throw new Error('No serializable Blockbench project is open');
    const compiled = await CodecsApi.project.compile({compressed: false});
    const document = typeof compiled === 'string' ? JSON.parse(compiled) : compiled;
    root.__modmindProjectSnapshots = root.__modmindProjectSnapshots instanceof Map ? root.__modmindProjectSnapshots : new Map();
    const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    root.__modmindProjectSnapshots.set(token, {
      uuid: String(activeProject.uuid || ''), name: String(activeProject.name || ''), formatId: String(activeProject.format && activeProject.format.id || ''),
      document, metadata: activeProject.unhandled_root_fields && activeProject.unhandled_root_fields.modmind_asset
    });
    return {message: 'Project snapshot created', data: {token}};
  }

  if (action.type === 'restore-project-snapshot') {
    const snapshots = root.__modmindProjectSnapshots;
    const snapshot = snapshots instanceof Map ? snapshots.get(action.token) : null;
    if (!snapshot) throw new Error('Blockbench project snapshot is unavailable');
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (activeProject && typeof activeProject.close === 'function') await activeProject.close(true);
    const format = FormatsApi[snapshot.formatId];
    if (!format || typeof setupProjectApi !== 'function') throw new Error('Blockbench cannot restore the project format');
    setupProjectApi(format, snapshot.uuid);
    CodecsApi.project.parse(snapshot.document, 'modmind-rollback.bbmodel');
    const restored = typeof Project !== 'undefined' ? Project : root.Project;
    if (restored) restored.name = snapshot.name;
    if (restored && snapshot.metadata) {
      restored.unhandled_root_fields = restored.unhandled_root_fields && typeof restored.unhandled_root_fields === 'object' ? restored.unhandled_root_fields : {};
      restored.unhandled_root_fields.modmind_asset = snapshot.metadata;
    }
    snapshots.delete(action.token);
    return {message: 'Project snapshot restored'};
  }

  if (action.type === 'discard-project-snapshot') {
    if (root.__modmindProjectSnapshots instanceof Map) root.__modmindProjectSnapshots.delete(action.token);
    return {message: 'Project snapshot discarded'};
  }

  if (action.type === 'clone-project') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (!activeProject || !CodecsApi || !CodecsApi.project || typeof CodecsApi.project.compile !== 'function' || typeof setupProjectApi !== 'function') throw new Error('No cloneable Blockbench project is open');
    const originalProjectUuid = String(activeProject.uuid || '');
    const format = activeProject.format;
    const compiled = await CodecsApi.project.compile({compressed: false});
    const document = typeof compiled === 'string' ? JSON.parse(compiled) : compiled;
    const metadata = activeProject.unhandled_root_fields && activeProject.unhandled_root_fields.modmind_asset;
    setupProjectApi(format);
    CodecsApi.project.parse(document, 'modmind-preview.bbmodel');
    const clone = typeof Project !== 'undefined' ? Project : root.Project;
    if (clone && metadata) {
      clone.unhandled_root_fields = clone.unhandled_root_fields && typeof clone.unhandled_root_fields === 'object' ? clone.unhandled_root_fields : {};
      clone.unhandled_root_fields.modmind_asset = metadata;
    }
    return {message: 'Project cloned', data: {projectUuid: String(clone && clone.uuid || ''), originalProjectUuid}};
  }

  if (action.type === 'inspect-project') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (!activeProject) throw new Error('No Blockbench project is open');
    const format = activeProject.format || (typeof Format !== 'undefined' ? Format : root.Format) || {};
    const groups = GroupApi && Array.isArray(GroupApi.all) ? GroupApi.all : [];
    const cubes = CubeApi && Array.isArray(CubeApi.all) ? CubeApi.all : [];
    const meshes = MeshApi && Array.isArray(MeshApi.all) ? MeshApi.all : [];
    const textures = TextureApi && Array.isArray(TextureApi.all) ? TextureApi.all : [];
    const animations = AnimationApi && Array.isArray(AnimationApi.all) ? AnimationApi.all : [];
    const nodes = allNodes();
    const armatures = nodes.filter((node) => node && node.type === 'armature');
    const bones = nodes.filter((node) => node && node.type === 'armature_bone');
    const locators = nodes.filter((node) => node && node.type === 'locator');
    const ikTargets = nodes.filter((node) => node && node.type === 'null_object');
    const faceNames = ['north', 'east', 'south', 'west', 'up', 'down'];

    const data = {
      project: {
        uuid: String(activeProject.uuid || ''),
        name: String(activeProject.name || ''),
        saved: activeProject.saved === true,
        textureWidth: Number(activeProject.texture_width || 16),
        textureHeight: Number(activeProject.texture_height || 16)
      },
      format: {id: String(format.id || ''), name: String(format.name || format.display_name || '')},
      counts: {
        cubes: cubes.length,
        groups: groups.length,
        meshes: meshes.length,
        textures: textures.length,
        animations: animations.length,
        armatures: armatures.length,
        bones: bones.length,
        locators: locators.length,
        ikTargets: ikTargets.length
      },
      cubes: cubes.map((cube) => ({
        kind: 'cube',
        uuid: String(cube.uuid || ''),
        name: String(cube.name || ''),
        parentUuid: parentUuid(cube),
        from: vector3(cube.from),
        to: vector3(cube.to),
        origin: vector3(cube.origin),
        rotation: vector3(cube.rotation),
        inflate: Number.isFinite(Number(cube.inflate)) ? Number(cube.inflate) : 0,
        visibility: cube.visibility !== false,
        boxUv: cube.box_uv === true,
        uvOffset: Array.isArray(cube.uv_offset) ? [Number(cube.uv_offset[0]) || 0, Number(cube.uv_offset[1]) || 0] : undefined,
        faces: Object.fromEntries(faceNames.map((faceName) => {
          const face = cube.faces && cube.faces[faceName];
          const uv = face && Array.isArray(face.uv) && face.uv.length >= 4
            ? face.uv.slice(0, 4).map((value) => Number(value) || 0)
            : undefined;
          const textureUuid = face && typeof face.texture === 'string' && face.texture && face.texture !== 'null'
            ? face.texture
            : undefined;
          return [faceName, {
            uv,
            rotation: face && Number.isFinite(Number(face.rotation)) ? Number(face.rotation) : undefined,
            textureUuid,
            enabled: !!face && face.enabled !== false
          }];
        }))
      })),
      groups: groups.map((group) => ({
        kind: 'group',
        uuid: String(group.uuid || ''),
        name: String(group.name || ''),
        parentUuid: parentUuid(group),
        origin: vector3(group.origin),
        rotation: vector3(group.rotation),
        visibility: group.visibility !== false,
        children: Array.isArray(group.children) ? group.children.map((child) => String(child.uuid || '')).filter(Boolean) : []
      })),
      meshes: meshes.map((mesh) => ({
        kind: 'mesh',
        uuid: String(mesh.uuid || ''),
        name: String(mesh.name || ''),
        parentUuid: parentUuid(mesh),
        origin: vector3(mesh.origin),
        rotation: vector3(mesh.rotation),
        visibility: mesh.visibility !== false,
        shading: mesh.shading === 'smooth' ? 'smooth' : 'flat',
        vertices: Object.fromEntries(Object.entries(mesh.vertices || {}).map(([key, value]) => [key, vector3(value)])),
        faces: Object.fromEntries(Object.entries(mesh.faces || {}).map(([key, face]) => [key, {
          vertices: Array.isArray(face.vertices) ? face.vertices.map(String) : [],
          uv: Object.fromEntries(Object.entries(face.uv || {}).map(([vertex, value]) => [vertex, Array.isArray(value) ? [Number(value[0]) || 0, Number(value[1]) || 0] : [0, 0]])),
          textureUuid: typeof face.texture === 'string' && face.texture ? face.texture : undefined
        }])),
        seams: mesh.seams && typeof mesh.seams === 'object' ? {...mesh.seams} : {},
        vertexCount: mesh.vertices && typeof mesh.vertices === 'object' ? Object.keys(mesh.vertices).length : 0,
        faceCount: mesh.faces && typeof mesh.faces === 'object' ? Object.keys(mesh.faces).length : 0,
        geometryHash: contentHash({
          vertices: Object.fromEntries(Object.entries(mesh.vertices || {}).map(([key, value]) => [key, vector3(value)])),
          faces: Object.fromEntries(Object.entries(mesh.faces || {}).map(([key, face]) => [key, {
            vertices: Array.isArray(face.vertices) ? face.vertices.map(String) : [],
            uv: Object.fromEntries(Object.entries(face.uv || {}).map(([vertex, value]) => [vertex, Array.isArray(value) ? [Number(value[0]) || 0, Number(value[1]) || 0] : [0, 0]])),
            textureUuid: typeof face.texture === 'string' && face.texture ? face.texture : undefined
          }]))
        })
      })),
      armatures: armatures.map((armature) => ({
        uuid: String(armature.uuid || ''), name: String(armature.name || ''), origin: vector3(armature.origin),
        children: Array.isArray(armature.children) ? armature.children.map((child) => String(child.uuid || '')).filter(Boolean) : []
      })),
      bones: bones.map((bone) => ({
        uuid: String(bone.uuid || ''), name: String(bone.name || ''), parentUuid: parentUuid(bone),
        origin: vector3(bone.origin), rotation: vector3(bone.rotation),
        vertexWeights: bone.vertex_weights && typeof bone.vertex_weights === 'object' ? {...bone.vertex_weights} : {},
        children: Array.isArray(bone.children) ? bone.children.map((child) => String(child.uuid || '')).filter(Boolean) : []
      })),
      locators: locators.map((locator) => ({
        uuid: String(locator.uuid || ''), name: String(locator.name || ''), parentUuid: parentUuid(locator), position: vector3(locator.position)
      })),
      ikTargets: ikTargets.map((target) => ({
        uuid: String(target.uuid || ''), name: String(target.name || ''), parentUuid: parentUuid(target), position: vector3(target.position),
        targetUuid: typeof target.ik_target === 'string' && target.ik_target ? target.ik_target : undefined,
        sourceUuid: typeof target.ik_source === 'string' && target.ik_source ? target.ik_source : undefined,
        lockRotation: target.lock_ik_target_rotation === true
      })),
      textures: textures.map((texture) => ({
        uuid: String(texture.uuid || ''),
        name: String(texture.name || ''),
        width: Number(texture.width || activeProject.texture_width || 16),
        height: Number(texture.height || activeProject.texture_height || 16),
        visible: texture.visible !== false,
        saved: texture.saved === true,
        pixelHash: contentHash(typeof texture.getDataURL === 'function' ? texture.getDataURL() : texture.source || ''),
        source: typeof texture.source === 'string' && !texture.source.startsWith('data:') ? texture.source : undefined
      })),
      animations: animations.map((animation) => {
        const rawAnimators = animation.animators && typeof animation.animators === 'object'
          ? Object.values(animation.animators)
          : [];
        return {
          uuid: String(animation.uuid || ''),
          name: String(animation.name || ''),
          length: Number(animation.length || 0),
          loop: String(animation.loop || 'once'),
          snapping: Number(animation.snapping || 20),
          selected: AnimationApi && AnimationApi.selected === animation,
          contentHash: contentHash(rawAnimators.map((animator) => ({
            uuid: animator.uuid || '',
            rotation: keyframeSnapshot(animator.rotation),
            position: keyframeSnapshot(animator.position),
            scale: keyframeSnapshot(animator.scale)
          }))),
          animators: rawAnimators.map((animator) => ({
            targetUuid: String(animator.uuid || animator.group && animator.group.uuid || ''),
            rotationKeyframes: Array.isArray(animator.rotation) ? animator.rotation.length : 0,
            positionKeyframes: Array.isArray(animator.position) ? animator.position.length : 0,
            scaleKeyframes: Array.isArray(animator.scale) ? animator.scale.length : 0
          })).filter((animator) => animator.targetUuid)
        };
      }),
      selection: OutlinerApi && Array.isArray(OutlinerApi.selected)
        ? OutlinerApi.selected.map((element) => String(element.uuid || '')).filter(Boolean)
        : [],
      metadata: activeProject.unhandled_root_fields && typeof activeProject.unhandled_root_fields.modmind_asset === 'object'
        ? activeProject.unhandled_root_fields.modmind_asset
        : undefined
    };
    return {message: 'Project inspected', data};
  }

  if (action.type === 'capture-views') {
    if (!ScreencamApi || typeof ScreencamApi.screenshotPreview !== 'function' || !ScreencamApi.NoAAPreview) {
      throw new Error('Blockbench screenshot API is unavailable');
    }
    if (!Array.isArray(DefaultCameraPresetsApi)) throw new Error('Blockbench camera presets are unavailable');
    const points = [];
    const cubes = CubeApi && Array.isArray(CubeApi.all) ? CubeApi.all : [];
    for (const cube of cubes) {
      if (Array.isArray(cube.from)) points.push(vector3(cube.from));
      if (Array.isArray(cube.to)) points.push(vector3(cube.to));
    }
    const meshes = MeshApi && Array.isArray(MeshApi.all) ? MeshApi.all : [];
    for (const mesh of meshes) {
      const origin = vector3(mesh.origin);
      if (!mesh.vertices || typeof mesh.vertices !== 'object') continue;
      for (const vertex of Object.values(mesh.vertices)) {
        const local = vector3(vertex);
        points.push(local.map((value, index) => value + origin[index]));
      }
    }
    const bounds = points.length ? [0, 1, 2].map((axis) => {
      const values = points.map((point) => point[axis]);
      return [Math.min(...values), Math.max(...values)];
    }) : [[-8, 8], [0, 16], [-8, 8]];
    let target = bounds.map(([minimum, maximum]) => (minimum + maximum) / 2);
    let largestSpan = Math.max(1, ...bounds.map(([minimum, maximum]) => maximum - minimum));
    if (ThreeApi && typeof ThreeApi.Box3 === 'function' && typeof ThreeApi.Vector3 === 'function') {
      const worldBounds = new ThreeApi.Box3();
      for (const element of [...cubes, ...meshes]) {
        if (element && element.mesh) worldBounds.expandByObject(element.mesh);
      }
      if (typeof worldBounds.isEmpty !== 'function' || !worldBounds.isEmpty()) {
        const worldCenter = worldBounds.getCenter(new ThreeApi.Vector3());
        const worldSize = worldBounds.getSize(new ThreeApi.Vector3());
        target = [worldCenter.x, worldCenter.y, worldCenter.z];
        largestSpan = Math.max(1, worldSize.x, worldSize.y, worldSize.z);
      }
    }
    const captures = [];
    for (const view of action.views) {
      const preset = DefaultCameraPresetsApi.find((candidate) => candidate && candidate.id === view);
      if (!preset) throw new Error('Blockbench camera preset is unavailable: ' + view);
      const preview = ScreencamApi.NoAAPreview;
      const presetTarget = vector3(preset.target);
      const position = vector3(preset.position).map((value, index) => value + target[index] - presetTarget[index]);
      const framedPreset = {...preset, target, position};
      preview.loadAnglePreset(framedPreset);
      if (preview.controls && preview.controls.target && typeof preview.controls.target.fromArray === 'function') {
        preview.controls.target.fromArray(target);
      }
      if (preview.camera && preview.camera.position && typeof preview.camera.position.fromArray === 'function') {
        preview.camera.position.fromArray(position);
        if (typeof preview.camera.lookAt === 'function') preview.camera.lookAt(target[0], target[1], target[2]);
      }
      if (preview.isOrtho && preview.camera) {
        preview.camera.zoom = Math.min(typeof preset.zoom === 'number' ? preset.zoom : 0.5, 6 / largestSpan);
        if (typeof preview.camera.updateProjectionMatrix === 'function') preview.camera.updateProjectionMatrix();
      }
      if (preview.controls && typeof preview.controls.update === 'function') preview.controls.update();
      if (typeof preview.resize === 'function') preview.resize(action.width, action.height);
      const dataUrl = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Blockbench screenshot timed out')), 20000);
        try {
          ScreencamApi.screenshotPreview(preview, {width: action.width, height: action.height, crop: false}, (result) => {
            clearTimeout(deadline);
            resolve(result);
          });
        } catch (error) {
          clearTimeout(deadline);
          reject(error);
        }
      });
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('Blockbench returned an invalid screenshot');
      }
      captures.push({view, width: action.width, height: action.height, dataUrl});
    }
    return {message: 'Views captured', captures};
  }

  if (action.type === 'new-model') {
    const format = FormatsApi[action.format];
    if (!format) throw new Error('This Blockbench build does not support format: ' + action.format);
    if (typeof newProjectApi !== 'function') throw new Error('Blockbench newProject API is unavailable');
    const created = await newProjectApi(format);
    if (created === false) throw new Error('Blockbench cancelled project creation');
    const createdProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (createdProject) {
      createdProject.name = action.name;
      if (action.textureWidth) createdProject.texture_width = action.textureWidth;
      if (action.textureHeight) createdProject.texture_height = action.textureHeight;
      createdProject.saved = false;
    }
    if (typeof BlockbenchApi.dispatchEvent === 'function') {
      BlockbenchApi.dispatchEvent('update_project_settings', {});
    }
    return {message: 'Model created', data: {name: action.name, format: action.format, projectUuid: String(createdProject && createdProject.uuid || '')}};
  }

  if (action.type === 'add-group') {
    if (!GroupApi) throw new Error('Blockbench group API is unavailable');
    const requestedParent = action.parentGroupUuid || action.parentGroupName
      ? findNode(action.parentGroupUuid, action.parentGroupName)
      : null;
    if ((action.parentGroupUuid || action.parentGroupName) && !requestedParent) {
      throw new Error('Parent group not found: ' + (action.parentGroupUuid || action.parentGroupName));
    }
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({outliner: true});
    let group = new GroupApi({name: action.name, origin: action.origin, rotation: action.rotation});
    if (typeof group.addTo === 'function') group = group.addTo(requestedParent || 'root');
    if (typeof group.init === 'function') group = group.init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add group', {outliner: true});
    updateCanvas([]);
    return {message: 'Group added', data: {uuid: String(group.uuid), name: action.name}};
  }

  if (action.type === 'add-cube') {
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: []});
    const config = {
      name: action.name,
      from: action.from,
      to: action.to,
      origin: action.origin,
      rotation: action.rotation,
      inflate: action.inflate || 0
    };
    let cube = new CubeApi(config);
    const requestedParent = action.parentGroupUuid || action.parentGroupName
      ? findNode(action.parentGroupUuid, action.parentGroupName)
      : null;
    if ((action.parentGroupUuid || action.parentGroupName) && !requestedParent) {
      throw new Error('Parent group not found: ' + (action.parentGroupUuid || action.parentGroupName));
    }
    const parent = requestedParent || GroupApi && GroupApi.first_selected || 'root';
    if (typeof cube.addTo === 'function') cube = cube.addTo(parent);
    if (typeof cube.init === 'function') cube = cube.init();
    const textures = typeof Texture !== 'undefined' && Texture.all ? Texture.all : TextureApi.all;
    const requestedTexture = action.textureUuid
      ? Array.isArray(textures) && textures.find((item) => item.uuid === action.textureUuid)
      : Array.isArray(textures) && textures.find((item) => item.name === action.textureName);
    if ((action.textureUuid || action.textureName) && !requestedTexture) {
      throw new Error('Texture not found: ' + (action.textureUuid || action.textureName));
    }
    if (requestedTexture && cube.faces) {
      Object.keys(cube.faces).forEach((face) => { cube.faces[face].texture = requestedTexture.uuid; });
    }
    if (UndoApi && typeof UndoApi.finishEdit === 'function') {
      UndoApi.finishEdit('Add cube', {elements: [cube]});
    }
    updateCanvas([cube]);
    return {message: 'Cube added', data: {uuid: String(cube.uuid), name: action.name}};
  }

  if (action.type === 'update-cube') {
    const elements = OutlinerApi && Array.isArray(OutlinerApi.elements) ? OutlinerApi.elements : [];
    const cube = elements.find((element) => element && element.type === 'cube' && (action.cubeUuid ? element.uuid === action.cubeUuid : element.name === action.cubeName));
    if (!cube) throw new Error('Cube not found: ' + (action.cubeUuid || action.cubeName));
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [cube]});
    if (action.from) cube.from.replace(action.from);
    if (action.to) cube.to.replace(action.to);
    if (action.origin) cube.origin.replace(action.origin);
    if (action.rotation) cube.rotation.replace(action.rotation);
    if (typeof action.inflate === 'number') cube.inflate = action.inflate;
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Refine cube', {elements: [cube]});
    updateCanvas([cube]);
    return {message: 'Cube updated', data: {uuid: String(cube.uuid), name: String(cube.name)}};
  }

  if (action.type === 'update-group') {
    const group = findNode(action.groupUuid, action.groupName);
    if (!group) throw new Error('Group not found: ' + (action.groupUuid || action.groupName));
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({outliner: true, groups: [group]});
    if (action.origin) group.origin.replace(action.origin);
    if (action.rotation) group.rotation.replace(action.rotation);
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Refine group', {outliner: true, groups: [group]});
    updateCanvas(Array.isArray(group.children) ? group.children : []);
    return {message: 'Group updated', data: {uuid: String(group.uuid), name: String(group.name)}};
  }

  if (action.type === 'add-mesh') {
    if (!MeshApi || !MeshFaceApi) throw new Error('Blockbench mesh API is unavailable');
    const parent = action.parentGroupUuid || action.parentGroupName
      ? findNode(action.parentGroupUuid, action.parentGroupName)
      : 'root';
    if (!parent) throw new Error('Mesh parent not found: ' + (action.parentGroupUuid || action.parentGroupName));
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [], outliner: true});
    let mesh = new MeshApi({name: action.name, vertices: action.vertices, faces: {}, origin: action.origin, rotation: action.rotation, shading: action.shading || 'flat'});
    for (const faceInput of action.faces) {
      const texture = faceInput.textureUuid || faceInput.textureName ? findTexture(faceInput.textureUuid, faceInput.textureName) : null;
      if ((faceInput.textureUuid || faceInput.textureName) && !texture) throw new Error('Mesh face texture not found: ' + (faceInput.textureUuid || faceInput.textureName));
      const face = new MeshFaceApi(mesh, {vertices: faceInput.vertices, uv: faceInput.uv || {}, texture: texture ? texture.uuid : false});
      if (faceInput.id) mesh.faces[faceInput.id] = face;
      else mesh.addFaces(face);
    }
    if (typeof mesh.addTo === 'function') mesh = mesh.addTo(parent);
    if (typeof mesh.init === 'function') mesh = mesh.init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add mesh', {elements: [mesh], outliner: true});
    updateCanvas([mesh]);
    return {message: 'Mesh added', data: {uuid: String(mesh.uuid), name: String(mesh.name), vertices: Object.keys(mesh.vertices || {}).length, faces: Object.keys(mesh.faces || {}).length}};
  }

  if (action.type === 'update-mesh') {
    const mesh = findNode(action.meshUuid, action.meshName, 'mesh');
    if (!mesh || !MeshFaceApi) throw new Error('Mesh not found: ' + (action.meshUuid || action.meshName));
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [mesh]});
    if (action.vertices) mesh.vertices = Object.fromEntries(Object.entries(action.vertices).map(([key, value]) => [key, vector3(value)]));
    if (action.faces) {
      mesh.faces = {};
      for (const faceInput of action.faces) {
        const texture = faceInput.textureUuid || faceInput.textureName ? findTexture(faceInput.textureUuid, faceInput.textureName) : null;
        if ((faceInput.textureUuid || faceInput.textureName) && !texture) throw new Error('Mesh face texture not found: ' + (faceInput.textureUuid || faceInput.textureName));
        const face = new MeshFaceApi(mesh, {vertices: faceInput.vertices, uv: faceInput.uv || {}, texture: texture ? texture.uuid : false});
        if (faceInput.id) mesh.faces[faceInput.id] = face;
        else mesh.addFaces(face);
      }
    }
    if (action.origin) mesh.origin.replace(action.origin);
    if (action.rotation) mesh.rotation.replace(action.rotation);
    if (action.shading) mesh.shading = action.shading;
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Update mesh', {elements: [mesh]});
    updateCanvas([mesh]);
    return {message: 'Mesh updated', data: {uuid: String(mesh.uuid), name: String(mesh.name)}};
  }

  if (action.type === 'delete-elements') {
    const nodes = action.elementUuids.map((uuid) => findNode(uuid)).filter(Boolean);
    if (nodes.length !== action.elementUuids.length) throw new Error('One or more elements to delete were not found');
    const undoElements = nodes.filter((node) => node.type !== 'group' && node.type !== 'armature' && node.type !== 'armature_bone');
    const undoGroups = nodes.filter((node) => node.type === 'group');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: undoElements, groups: undoGroups, outliner: true});
    for (const node of [...nodes].reverse()) {
      if (typeof node.remove !== 'function') throw new Error('Element cannot be deleted: ' + node.uuid);
      node.remove(false);
    }
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Delete elements', {outliner: true});
    updateCanvas([]);
    return {message: 'Elements deleted', data: {count: nodes.length}};
  }

  if (action.type === 'duplicate-element') {
    const source = findNode(action.elementUuid);
    if (!source || source.type === 'group' || source.type === 'armature' || source.type === 'armature_bone') throw new Error('Element cannot be duplicated: ' + action.elementUuid);
    const parent = action.parentGroupUuid || action.parentGroupName
      ? findNode(action.parentGroupUuid, action.parentGroupName)
      : source.parent || 'root';
    if (!parent) throw new Error('Duplicate parent not found');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [], outliner: true});
    let copy = new source.constructor(source);
    copy.name = action.name;
    const offset = action.offset || [0, 0, 0];
    if (Array.isArray(copy.from)) copy.from = copy.from.map((value, axis) => value + offset[axis]);
    if (Array.isArray(copy.to)) copy.to = copy.to.map((value, axis) => value + offset[axis]);
    if (Array.isArray(copy.origin)) copy.origin = copy.origin.map((value, axis) => value + offset[axis]);
    if (Array.isArray(copy.position)) copy.position = copy.position.map((value, axis) => value + offset[axis]);
    if (typeof copy.addTo === 'function') copy = copy.addTo(parent);
    if (typeof copy.init === 'function') copy = copy.init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Duplicate element', {elements: [copy], outliner: true});
    updateCanvas([copy]);
    return {message: 'Element duplicated', data: {uuid: String(copy.uuid), name: String(copy.name)}};
  }

  if (action.type === 'rename-element') {
    const element = findNode(action.elementUuid);
    if (!element) throw new Error('Element not found: ' + action.elementUuid);
    const undoElements = element.type === 'group' || element.type === 'armature' || element.type === 'armature_bone' ? [] : [element];
    const undoGroups = element.type === 'group' ? [element] : [];
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: undoElements, groups: undoGroups, outliner: true});
    element.name = action.name;
    if (typeof element.sanitizeName === 'function') element.sanitizeName();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Rename element', {elements: undoElements, groups: undoGroups, outliner: true});
    return {message: 'Element renamed', data: {uuid: String(element.uuid), name: String(element.name)}};
  }

  if (action.type === 'reparent-element') {
    const element = findNode(action.elementUuid);
    const parent = action.root ? 'root' : findNode(action.parentGroupUuid, action.parentGroupName);
    if (!element) throw new Error('Element not found: ' + action.elementUuid);
    if (!parent) throw new Error('Element parent not found');
    if (parent !== 'root' && (parent === element || typeof parent.isChildOf === 'function' && parent.isChildOf(element, 128))) throw new Error('Element parenting would create a cycle');
    const undoElements = element.type === 'group' || element.type === 'armature' || element.type === 'armature_bone' ? [] : [element];
    const undoGroups = [element, parent].filter((node) => node !== 'root' && node.type === 'group');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: undoElements, groups: undoGroups, outliner: true});
    element.addTo(parent);
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Reparent element', {elements: undoElements, groups: undoGroups, outliner: true});
    updateCanvas([element]);
    return {message: 'Element reparented', data: {uuid: String(element.uuid), parentUuid: parent === 'root' ? '' : String(parent.uuid)}};
  }

  if (action.type === 'update-cube-faces') {
    const cube = findNode(action.cubeUuid, action.cubeName, 'cube');
    if (!cube || !cube.faces) throw new Error('Cube not found: ' + (action.cubeUuid || action.cubeName));
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [cube], uv_only: true});
    for (const faceName in action.faces) {
      const update = action.faces[faceName];
      const face = cube.faces[faceName];
      if (!face || !update) continue;
      if (update.uv) face.uv.replace(update.uv);
      if (typeof update.rotation === 'number') face.rotation = update.rotation;
      if (typeof update.enabled === 'boolean') face.enabled = update.enabled;
      if (update.textureUuid || update.textureName) {
        const texture = findTexture(update.textureUuid, update.textureName);
        if (!texture) throw new Error('Face texture not found: ' + (update.textureUuid || update.textureName));
        face.texture = texture.uuid;
      }
    }
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Update cube faces', {elements: [cube], uv_only: true});
    updateCanvas([cube]);
    return {message: 'Cube faces updated', data: {uuid: String(cube.uuid)}};
  }

  if (action.type === 'paint-texture') {
    const texture = findTexture(action.textureUuid, action.textureName);
    if (!texture || typeof texture.getDataURL !== 'function' || typeof texture.fromDataURL !== 'function') throw new Error('Texture cannot be painted');
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Texture image could not be decoded'));
      image.src = texture.getDataURL();
    });
    const canvas = document.createElement('canvas');
    canvas.width = Number(texture.width || image.width || 16);
    canvas.height = Number(texture.height || image.height || 16);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (action.paletteMap) {
      const parseColor = (color) => {
        const sample = document.createElement('canvas').getContext('2d');
        sample.fillStyle = color;
        sample.fillRect(0, 0, 1, 1);
        return Array.from(sample.getImageData(0, 0, 1, 1).data);
      };
      const mappings = Object.entries(action.paletteMap).map(([from, to]) => [parseColor(from), parseColor(to)]);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const mapping = mappings.find(([from]) => from[0] === pixels.data[index] && from[1] === pixels.data[index + 1] && from[2] === pixels.data[index + 2] && from[3] === pixels.data[index + 3]);
        if (mapping) pixels.data.set(mapping[1], index);
      }
      context.putImageData(pixels, 0, 0);
    }
    for (const rectangle of action.rectangles || []) {
      context.fillStyle = rectangle.color;
      context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
    for (const stroke of action.strokes || []) {
      if (!stroke.points.length) continue;
      context.strokeStyle = stroke.color;
      context.lineWidth = stroke.size || 1;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(stroke.points[0][0], stroke.points[0][1]);
      stroke.points.slice(1).forEach((point) => context.lineTo(point[0], point[1]));
      context.stroke();
    }
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({textures: [texture], bitmap: true});
    texture.fromDataURL(canvas.toDataURL('image/png'));
    if (typeof texture.updateMaterial === 'function') texture.updateMaterial();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Paint texture', {textures: [texture], bitmap: true});
    if (CanvasApi && typeof CanvasApi.updateAllFaces === 'function') CanvasApi.updateAllFaces();
    return {message: 'Texture painted', data: {uuid: String(texture.uuid), name: String(texture.name)}};
  }

  if (action.type === 'auto-unwrap-mesh') {
    const mesh = findNode(action.meshUuid, action.meshName, 'mesh');
    if (!mesh || !mesh.faces) throw new Error('Mesh not found: ' + (action.meshUuid || action.meshName));
    const faces = Object.values(mesh.faces).filter((face) => Array.isArray(face.vertices) && face.vertices.length >= 3);
    if (!faces.length) throw new Error('Mesh has no unwrap-compatible faces');
    const width = action.textureWidth || Number(ProjectApi && ProjectApi.texture_width || 64);
    const height = action.textureHeight || Number(ProjectApi && ProjectApi.texture_height || 64);
    const padding = action.padding === undefined ? 1 : action.padding;
    const columns = Math.ceil(Math.sqrt(faces.length));
    const rows = Math.ceil(faces.length / columns);
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [mesh], uv_only: true});
    faces.forEach((face, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = column * cellWidth + padding;
      const top = row * cellHeight + padding;
      const right = (column + 1) * cellWidth - padding;
      const bottom = (row + 1) * cellHeight - padding;
      const corners = [[left, bottom], [left, top], [right, top], [right, bottom]];
      face.vertices.forEach((vertex, vertexIndex) => { face.uv[vertex] = corners[vertexIndex % 4].slice(); });
      if (typeof face.getEdges === 'function' && typeof mesh.setSeam === 'function') face.getEdges().forEach((edge) => mesh.setSeam(edge, 'divide'));
    });
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Auto unwrap mesh', {elements: [mesh], uv_only: true});
    updateCanvas([mesh]);
    return {message: 'Mesh UVs unwrapped', data: {uuid: String(mesh.uuid), faces: faces.length, width, height}};
  }

  if (action.type === 'add-armature') {
    if (!ArmatureApi) throw new Error('Blockbench armature API is unavailable');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({outliner: true});
    let armature = new ArmatureApi({name: action.name, origin: action.origin || [0, 0, 0]});
    armature = armature.addTo('root').init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add armature', {outliner: true});
    return {message: 'Armature added', data: {uuid: String(armature.uuid), name: String(armature.name)}};
  }

  if (action.type === 'add-bone') {
    if (!ArmatureBoneApi) throw new Error('Blockbench armature bone API is unavailable');
    const parent = action.parentBoneUuid || action.parentBoneName
      ? findNode(action.parentBoneUuid, action.parentBoneName, 'armature_bone')
      : findNode(action.armatureUuid, action.armatureName, 'armature');
    if (!parent) throw new Error('Bone parent armature or bone was not found');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({outliner: true});
    let bone = new ArmatureBoneApi({name: action.name, origin: action.origin || [0, 0, 0], rotation: action.rotation || [0, 0, 0]});
    bone = bone.addTo(parent).init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add armature bone', {outliner: true});
    return {message: 'Bone added', data: {uuid: String(bone.uuid), name: String(bone.name)}};
  }

  if (action.type === 'set-vertex-weights') {
    const mesh = findNode(action.meshUuid, action.meshName, 'mesh');
    if (!mesh || !mesh.vertices) throw new Error('Mesh not found: ' + (action.meshUuid || action.meshName));
    const bones = ArmatureBoneApi && Array.isArray(ArmatureBoneApi.all) ? ArmatureBoneApi.all : allNodes().filter((node) => node.type === 'armature_bone');
    if (!bones.length) throw new Error('No armature bones are available');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [mesh], outliner: true});
    for (const vertex in action.weights) {
      if (!mesh.vertices[vertex]) throw new Error('Mesh vertex not found: ' + vertex);
      bones.forEach((bone) => bone.setVertexWeight(mesh, vertex, 0));
      const entries = action.weights[vertex];
      const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
      if (total <= 0) continue;
      for (const entry of entries) {
        const bone = bones.find((candidate) => entry.boneUuid ? candidate.uuid === entry.boneUuid : candidate.name === entry.boneName);
        if (!bone) throw new Error('Armature bone not found: ' + (entry.boneUuid || entry.boneName));
        bone.setVertexWeight(mesh, vertex, entry.weight / total);
      }
    }
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Set vertex weights', {elements: [mesh], outliner: true});
    updateCanvas([mesh]);
    return {message: 'Vertex weights updated', data: {meshUuid: String(mesh.uuid), vertices: Object.keys(action.weights).length}};
  }

  if (action.type === 'add-locator') {
    if (!LocatorApi) throw new Error('Blockbench locator API is unavailable');
    const parent = action.parentGroupUuid || action.parentGroupName ? findNode(action.parentGroupUuid, action.parentGroupName) : 'root';
    if (!parent) throw new Error('Locator parent not found');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [], outliner: true});
    let locator = new LocatorApi({name: action.name, position: action.position});
    locator = locator.addTo(parent).init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add locator', {elements: [locator], outliner: true});
    return {message: 'Locator added', data: {uuid: String(locator.uuid), name: String(locator.name)}};
  }

  if (action.type === 'add-ik-target') {
    if (!NullObjectApi) throw new Error('Blockbench IK target API is unavailable');
    const target = findNode(action.targetGroupUuid, action.targetGroupName);
    const source = findNode(action.sourceGroupUuid, action.sourceGroupName);
    if (!target || !source) throw new Error('IK target and source groups are required');
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [], outliner: true});
    let object = new NullObjectApi({name: action.name, position: action.position, ik_target: target.uuid, ik_source: source.uuid, lock_ik_target_rotation: action.lockRotation === true});
    object = object.addTo('root').init();
    if (UndoApi && typeof UndoApi.finishEdit === 'function') UndoApi.finishEdit('Add IK target', {elements: [object], outliner: true});
    return {message: 'IK target added', data: {uuid: String(object.uuid), targetUuid: String(target.uuid), sourceUuid: String(source.uuid)}};
  }

  if (action.type === 'add-animation') {
    if (!AnimationApi) throw new Error('Blockbench animation API is unavailable');
    let animation = new AnimationApi({name: action.name, length: action.length, loop: action.loop || 'once', snapping: action.snapping || 20});
    if (typeof animation.add === 'function') animation = animation.add();
    return {message: 'Animation added', data: {uuid: String(animation.uuid), name: action.name}};
  }

  if (action.type === 'add-keyframe') {
    if (!AnimationApi) throw new Error('Blockbench animation API is unavailable');
    const animations = Array.isArray(AnimationApi.all) ? AnimationApi.all : [];
    const animation = animations.find((item) => action.animationUuid ? item.uuid === action.animationUuid : item.name === action.animationName);
    const group = findNode(action.groupUuid, action.groupName);
    if (!animation) throw new Error('Animation not found: ' + (action.animationUuid || action.animationName));
    if (!group) throw new Error('Animation group not found: ' + (action.groupUuid || action.groupName));
    if (typeof animation.getBoneAnimator !== 'function') throw new Error('Blockbench bone animator API is unavailable');
    const animator = animation.getBoneAnimator(group);
    if (!animator || typeof animator.addKeyframe !== 'function') throw new Error('Blockbench keyframe API is unavailable');
    const keyframe = animator.addKeyframe({
      channel: action.channel,
      time: action.time,
      interpolation: action.interpolation || 'linear',
      data_points: [{x: action.value[0], y: action.value[1], z: action.value[2]}]
    });
    return {message: 'Keyframe added', data: {uuid: String(keyframe && keyframe.uuid || ''), channel: action.channel, time: action.time}};
  }

  if (action.type === 'create-texture') {
    const activeProject = typeof Project !== 'undefined' ? Project : root.Project;
    if (!activeProject) {
      const textureFormat = FormatsApi.free || FormatsApi.java_block || FormatsApi.modded_entity;
      if (!textureFormat || typeof newProjectApi !== 'function') {
        throw new Error('Blockbench cannot create a standalone texture workspace');
      }
      const created = await newProjectApi(textureFormat);
      if (created === false) throw new Error('Blockbench cancelled texture workspace creation');
      const textureProject = typeof Project !== 'undefined' ? Project : root.Project;
      if (textureProject) {
        textureProject.name = 'texture_workspace';
        textureProject.texture_width = action.width;
        textureProject.texture_height = action.height;
      }
    }
    let dataUrl = action.dataUrl;
    if (!dataUrl) {
      const canvas = document.createElement('canvas');
      canvas.width = action.width;
      canvas.height = action.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D is unavailable');
      context.fillStyle = action.fill || '#00000000';
      context.fillRect(0, 0, action.width, action.height);
      if (Array.isArray(action.rectangles)) {
        action.rectangles.forEach((rectangle) => {
          context.fillStyle = rectangle.color;
          context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
        });
      }
      dataUrl = canvas.toDataURL('image/png');
    }
    let texture = new TextureApi({
      name: action.name,
      width: action.width,
      height: action.height,
      mode: 'bitmap'
    });
    if (typeof texture.fromDataURL !== 'function') throw new Error('Blockbench texture import API is unavailable');
    const imported = texture.fromDataURL(dataUrl);
    if (imported) texture = imported;
    if (typeof texture.add === 'function') texture.add(false);
    return {message: 'Texture created', data: {uuid: String(texture.uuid), name: action.name}};
  }

  if (action.type === 'set-cube-texture') {
    const elements = typeof Outliner !== 'undefined' ? Outliner.elements : (root.Outliner && root.Outliner.elements);
    const textures = typeof Texture !== 'undefined' && Texture.all ? Texture.all : TextureApi.all;
    const cube = Array.isArray(elements) && elements.find((element) =>
      action.cubeUuid ? element.uuid === action.cubeUuid : element.name === action.cubeName
    );
    const texture = Array.isArray(textures) && textures.find((item) =>
      action.textureUuid ? item.uuid === action.textureUuid : item.name === action.textureName
    );
    if (!cube || !cube.faces) throw new Error('Cube not found: ' + (action.cubeUuid || action.cubeName));
    if (!texture) throw new Error('Texture not found: ' + (action.textureUuid || action.textureName));
    const faces = action.faces || ['north', 'east', 'south', 'west', 'up', 'down'];
    if (UndoApi && typeof UndoApi.initEdit === 'function') UndoApi.initEdit({elements: [cube]});
    faces.forEach((face) => { if (cube.faces[face]) cube.faces[face].texture = texture.uuid; });
    if (UndoApi && typeof UndoApi.finishEdit === 'function') {
      UndoApi.finishEdit('Apply texture', {elements: [cube]});
    }
    updateCanvas([cube]);
    return {message: 'Texture applied', data: {cubeUuid: cube.uuid, textureUuid: texture.uuid}};
  }

  if (action.type === 'run-command') {
    const modeMap = {'mode-edit': 'edit', 'mode-paint': 'paint', 'mode-animate': 'animate'};
    const mode = modeMap[action.command];
    if (mode) {
      const modeOption = ModesApi && ModesApi.options && ModesApi.options[mode];
      if (!modeOption || typeof modeOption.select !== 'function') {
        throw new Error('Blockbench mode is unavailable: ' + mode);
      }
      modeOption.select();
      return {message: 'Mode changed', data: {command: action.command}};
    }
    const barItemMap = {
      undo: ['undo'],
      redo: ['redo'],
      'frame-all': ['frame_all'],
      'toggle-grid': ['toggle_grid'],
      'toggle-animate': ['play_animation', 'toggle_animate'],
      'open-project': ['open_model', 'open_project'],
      'save-project-dialog': ['save_project', 'save_project_as']
    };
    const candidates = barItemMap[action.command] || [];
    const item = candidates.map((id) => BarItemsApi && BarItemsApi[id]).find(Boolean);
    if (!item || typeof item.trigger !== 'function') {
      throw new Error('Blockbench command is unavailable: ' + action.command);
    }
    item.trigger();
    return {message: 'Command executed', data: {command: action.command}};
  }

  if (action.type === 'serialize-project') {
    if (!CodecsApi || !CodecsApi.project || typeof CodecsApi.project.compile !== 'function') {
      throw new Error('Blockbench project codec is unavailable');
    }
    const compiled = await CodecsApi.project.compile({compressed: false});
    const content = typeof compiled === 'string' ? compiled : JSON.stringify(compiled, null, 2);
    return {message: 'Project serialized', content};
  }

  if (action.type === 'serialize-export') {
    const codec = ProjectApi && ProjectApi.format && ProjectApi.format.codec;
    if (!codec || typeof codec.compile !== 'function') throw new Error('The active Blockbench format cannot be exported');
    const compiled = await codec.compile({raw: true});
    const content = typeof compiled === 'string' ? compiled : JSON.stringify(compiled, null, 2);
    return {message: 'Model exported', content};
  }

  if (action.type === 'serialize-texture') {
    const textures = typeof Texture !== 'undefined' && Texture.all ? Texture.all : TextureApi.all;
    const texture = Array.isArray(textures) && textures.find((item) =>
      action.textureUuid ? item.uuid === action.textureUuid : item.name === action.textureName
    );
    if (!texture || typeof texture.getDataURL !== 'function') throw new Error('Texture not found or cannot be serialized');
    const content = texture.getDataURL();
    if (typeof content !== 'string' || !content.startsWith('data:image/png;base64,')) {
      throw new Error('Blockbench returned an invalid PNG texture');
    }
    return {message: 'Texture serialized', content};
  }

  throw new Error('Unsupported Blockbench action');
}`

export class BlockbenchBridge {
  private readonly window: BrowserWindow
  private readonly entryPath: string
  private readonly getProjectRoot: () => string | null
  private readonly view: WebContentsView
  private readonly listeners = new Set<StatusListener>()
  private status: BlockbenchBridgeStatus
  private attached = false
  private destroyed = false
  private theme: 'light' | 'dark' = 'light'
  private actionQueue: Promise<void> = Promise.resolve()
  private readonly checkpoints: StoredBlockbenchCheckpoint[] = []

  constructor(options: BlockbenchBridgeOptions) {
    this.window = options.window
    this.entryPath = path.resolve(options.entryPath)
    this.getProjectRoot = options.getProjectRoot
    this.status = this.makeStatus('idle', false)
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: options.partition ?? 'persist:modmind-blockbench'
      }
    })
    this.view.setBackgroundColor('#f3f4f6')

    this.configureSecurity()
    this.bindLifecycleEvents()
  }

  getStatus(): BlockbenchBridgeStatus {
    return { ...this.status }
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<BlockbenchBridgeStatus> {
    this.assertAlive()
    const entry = await fs.stat(this.entryPath).catch(() => null)
    if (!entry?.isFile()) {
      const message = `Blockbench entry was not found: ${this.entryPath}`
      this.setStatus('error', message)
      throw new Error(message)
    }

    this.setStatus('loading', 'Loading embedded Blockbench')
    try {
      await this.view.webContents.loadFile(this.entryPath)
      const version = await this.waitUntilReady()
      await this.applyTheme()
      this.setStatus('ready', 'Blockbench is ready', version)
      return this.getStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus('error', message)
      throw error
    }
  }

  show(): void {
    this.assertAlive()
    if (this.attached && this.status.visible) return
    if (!this.attached) {
      this.window.contentView.addChildView(this.view)
      this.attached = true
    }
    this.view.setVisible(true)
    this.updateVisibility(true)
  }

  hide(): void {
    if (this.destroyed) return
    try {
      this.view.setVisible(false)
      if (this.attached && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(this.view)
      }
    } catch {
      // The host window can be closed while renderer cleanup is in flight.
    } finally {
      this.attached = false
      this.updateVisibility(false)
    }
  }

  setBounds(bounds: BlockbenchBounds): void {
    this.assertAlive()
    this.view.setBounds(validateBounds(bounds))
  }

  async setTheme(theme: 'light' | 'dark'): Promise<void> {
    this.assertAlive()
    if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid Blockbench theme')
    this.theme = theme
    this.view.setBackgroundColor(theme === 'dark' ? '#1c1d20' : '#f3f4f6')
    if (this.status.phase === 'ready') await this.applyTheme()
  }

  executeAction(action: BlockbenchAction): Promise<BlockbenchActionResult> {
    let validated: BlockbenchAction
    try {
      validated = validateAction(action)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(() => this.executeValidatedAction(validated))
  }

  executeActions(actions: BlockbenchAction[], signal?: AbortSignal, expectedRevision?: string): Promise<BlockbenchActionBatchResult> {
    const newModelIndex = Array.isArray(actions) ? actions.findIndex((action) => action?.type === 'new-model') : -1
    if (newModelIndex > 0) return Promise.reject(new Error('new-model must be the first action in a Blockbench batch'))
    return this.executeActionBatch(actions, signal, expectedRevision, newModelIndex === 0)
  }

  executeCandidateActions(actions: BlockbenchAction[], signal?: AbortSignal, expectedRevision?: string): Promise<BlockbenchActionBatchResult> {
    if (!Array.isArray(actions) || actions[0]?.type !== 'new-model') {
      return Promise.reject(new Error('A Blockbench candidate must begin with a new-model action'))
    }
    return this.executeActionBatch(actions, signal, expectedRevision, true)
  }

  previewCandidateActions(
    actions: BlockbenchAction[],
    request: BlockbenchCaptureRequest = {},
    signal?: AbortSignal,
    expectedRevision?: string
  ): Promise<{
      execution: BlockbenchActionBatchResult
      validation: BlockbenchValidationResult
      capture: BlockbenchCaptureResult
    }> {
    if (!Array.isArray(actions) || actions[0]?.type !== 'new-model') {
      return Promise.reject(new Error('A Blockbench candidate must begin with a new-model action'))
    }
    let validated: BlockbenchAction[]
    let normalizedCapture: Required<BlockbenchCaptureRequest>
    try {
      validated = validateActionBatch(actions, expectedRevision)
      normalizedCapture = validateCaptureRequest(request)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      const session = await this.runValidatedActionBatch(validated, signal, expectedRevision, true, false)
      try {
        if (signal?.aborted) throw Object.assign(new Error('Blockbench operation was cancelled'), { name: 'AbortError' })
        const state = await this.readProjectState()
        const validation = validateProjectState(state)
        const capture = await this.captureValidatedViews(normalizedCapture, state.revision)
        return { execution: session.execution, validation, capture }
      } finally {
        await this.discardCandidateProjects(session.createdProjectUuids, session.restoreProjectUuid)
      }
    })
  }

  previewRefinementActions(
    actions: BlockbenchAction[],
    request: BlockbenchCaptureRequest = {},
    signal?: AbortSignal,
    expectedRevision?: string
  ): Promise<{
    execution: BlockbenchActionBatchResult
    validation: BlockbenchValidationResult
    capture: BlockbenchCaptureResult
    baselineCapture: BlockbenchCaptureResult
    diff: BlockbenchProjectDiff
  }> {
    if (!Array.isArray(actions) || actions.some((action) => action.type === 'new-model')) {
      return Promise.reject(new Error('A Blockbench refinement cannot create a new model'))
    }
    let validated: BlockbenchAction[]
    let normalizedCapture: Required<BlockbenchCaptureRequest>
    try {
      validated = validateActionBatch(actions, expectedRevision)
      normalizedCapture = validateCaptureRequest(request)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      const originalProjectUuid = await this.activeProjectUuid()
      if (!originalProjectUuid) throw new Error('No Blockbench project is open')
      const before = await this.readProjectState()
      if (expectedRevision && before.revision !== expectedRevision) {
        throw new Error(`Blockbench project changed since it was inspected (expected ${expectedRevision}, current ${before.revision})`)
      }
      const baselineCapture = await this.captureValidatedViews(normalizedCapture, before.revision)
      const cloneResult = await this.invokePage({type: 'clone-project'})
      const cloneProjectUuid = cloneResult.data?.projectUuid
      if (typeof cloneProjectUuid !== 'string' || !cloneProjectUuid) throw new Error('Blockbench returned an invalid refinement clone')
      try {
        const results: BlockbenchActionResult[] = []
        for (const action of validated) {
          if (signal?.aborted) throw Object.assign(new Error('Blockbench operation was cancelled'), {name: 'AbortError'})
          results.push(await this.executeValidatedAction(action))
        }
        const state = await this.readProjectState()
        const validation = validateProjectState(state)
        const capture = await this.captureValidatedViews(normalizedCapture, state.revision)
        return {
          execution: {revisionBefore: before.revision, revisionAfter: state.revision, results}, validation, capture,
          baselineCapture,
          diff: diffBlockbenchProjects(before, state)
        }
      } finally {
        await this.discardProject(cloneProjectUuid, originalProjectUuid)
      }
    })
  }

  private executeActionBatch(
    actions: BlockbenchAction[],
    signal: AbortSignal | undefined,
    expectedRevision: string | undefined,
    isolatedNewProject: boolean
  ): Promise<BlockbenchActionBatchResult> {
    let validated: BlockbenchAction[]
    try {
      validated = validateActionBatch(actions, expectedRevision)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(async () => (await this.runValidatedActionBatch(
      validated, signal, expectedRevision, isolatedNewProject, true
    )).execution)
  }

  private async runValidatedActionBatch(
    validated: BlockbenchAction[],
    signal: AbortSignal | undefined,
    expectedRevision: string | undefined,
    isolatedNewProject: boolean,
    recordHistory: boolean
  ): Promise<BlockbenchCandidateSession> {
    const activeProjectUuid = await this.activeProjectUuid()
    const before = activeProjectUuid ? await this.readProjectState() : null
    const revisionBefore = before?.revision ?? EMPTY_PROJECT_REVISION
    if (!activeProjectUuid && !isolatedNewProject) throw new Error('No Blockbench project is open')
    if (expectedRevision && revisionBefore !== expectedRevision) {
      throw new Error(`Blockbench project changed since it was inspected (expected ${expectedRevision}, current ${revisionBefore})`)
    }
    const results: BlockbenchActionResult[] = []
    const createdProjectUuids: string[] = []
    const snapshotToken = isolatedNewProject ? null : await this.createProjectSnapshot()
    try {
      for (const action of validated) {
        if (signal?.aborted) throw Object.assign(new Error('Blockbench operation was cancelled'), { name: 'AbortError' })
        const result = await this.executeValidatedAction(action)
        results.push(result)
        if (isolatedNewProject && action.type === 'new-model' && typeof result.data?.projectUuid === 'string') {
          createdProjectUuids.push(result.data.projectUuid)
        }
      }
      const after = await this.readProjectState()
      if (snapshotToken) {
        if (recordHistory && before) await this.rememberCheckpoint(snapshotToken, before, validated)
        else await this.discardProjectSnapshot(snapshotToken)
      }
      return {
        execution: { revisionBefore, revisionAfter: after.revision, results },
        createdProjectUuids,
        restoreProjectUuid: activeProjectUuid
      }
    } catch (error) {
      if (snapshotToken) {
        try {
          await this.restoreProjectSnapshot(snapshotToken)
        } catch (rollbackError) {
          throw new Error(
            `Blockbench batch failed and rollback also failed. Batch error: ${errorMessage(error)}. Rollback error: ${errorMessage(rollbackError)}`,
            {cause: error}
          )
        }
        throw new Error(`Blockbench batch failed and the project was restored: ${errorMessage(error)}`, {cause: error})
      }
      if (!isolatedNewProject || createdProjectUuids.length === 0) throw error
      try {
        await this.discardCandidateProjects(createdProjectUuids, activeProjectUuid)
      } catch (rollbackError) {
        throw new Error(
          `Blockbench candidate failed and rollback also failed. Candidate error: ${errorMessage(error)}. Rollback error: ${errorMessage(rollbackError)}`,
          { cause: error }
        )
      }
      throw new Error(`Blockbench candidate failed and was discarded: ${errorMessage(error)}`, { cause: error })
    }
  }

  getProjectState(): Promise<BlockbenchProjectState> {
    return this.enqueue(() => this.readProjectState())
  }

  validateProject(): Promise<BlockbenchValidationResult> {
    return this.enqueue(async () => validateProjectState(await this.readProjectState()))
  }

  captureViews(request: BlockbenchCaptureRequest = {}): Promise<BlockbenchCaptureResult> {
    let normalized: Required<BlockbenchCaptureRequest>
    try {
      normalized = validateCaptureRequest(request)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      const state = await this.readProjectState()
      return this.captureValidatedViews(normalized, state.revision)
    })
  }

  listHistory(): Promise<BlockbenchHistoryEntry[]> {
    return this.enqueue(async () => this.checkpoints.map((checkpoint) => ({...checkpoint.entry})).reverse())
  }

  createCheckpoint(label = 'Manual checkpoint'): Promise<BlockbenchHistoryEntry> {
    const normalizedLabel = normalizeCheckpointLabel(label)
    return this.enqueue(async () => {
      const state = await this.readProjectState()
      const token = await this.createProjectSnapshot()
      return this.rememberCheckpoint(token, state, [], normalizedLabel)
    })
  }

  restoreHistory(id: string): Promise<{restored: BlockbenchHistoryEntry; revision: string}> {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return Promise.reject(new Error('Invalid Blockbench history ID'))
    return this.enqueue(async () => {
      const index = this.checkpoints.findIndex((checkpoint) => checkpoint.entry.id === id)
      if (index < 0) throw new Error('Blockbench history checkpoint was not found')
      const selected = this.checkpoints[index]
      const current = await this.readProjectState()
      const currentToken = await this.createProjectSnapshot()
      try {
        await this.restoreProjectSnapshot(selected.token)
      } catch (error) {
        await this.discardProjectSnapshot(currentToken).catch(() => undefined)
        throw error
      }
      this.checkpoints.splice(index, 1)
      await this.rememberCheckpoint(currentToken, current, [], `Before restoring ${selected.entry.label}`)
      const restored = await this.readProjectState()
      return {restored: {...selected.entry}, revision: restored.revision}
    })
  }

  setAssetMetadata(metadata: BlockbenchAssetMetadata): Promise<BlockbenchActionResult> {
    const normalized = validateAssetMetadata(metadata)
    return this.enqueue(async () => {
      const result = await this.invokePage({ type: 'set-asset-metadata', metadata: normalized })
      return {action: 'run-command', success: true, message: result.message, data: result.data as BlockbenchActionResult['data']}
    })
  }

  saveAssetBundle(request: BlockbenchAssetSaveRequest): Promise<BlockbenchAssetSaveResult> {
    const normalized = validateAssetSaveRequest(request)
    return this.enqueue(async () => {
      const metadata = validateAssetMetadata(normalized.metadata)
      await this.invokePage({ type: 'set-asset-metadata', metadata })
      const projectResult = await this.invokePage({ type: 'serialize-project' })
      const textureResult = await this.invokePage({ type: 'serialize-texture', textureName: normalized.textureName })
      if (typeof projectResult.content !== 'string') throw new Error('Blockbench returned an invalid project')
      const projectDocument = parseProjectDocument(projectResult.content)
      projectDocument.modmind_asset = metadata
      const projectContent = `${JSON.stringify(projectDocument, null, 2)}\n`
      if (Buffer.byteLength(projectContent, 'utf8') > 50 * 1024 * 1024) {
        throw new Error('Blockbench project exceeds the 50 MiB save limit')
      }
      if (typeof textureResult.content !== 'string' || !textureResult.content.startsWith('data:image/png;base64,')) {
        throw new Error('Blockbench returned an invalid PNG texture')
      }
      const textureContent = Buffer.from(textureResult.content.slice('data:image/png;base64,'.length), 'base64')
      if (!textureContent.length || textureContent.length > 8 * 1024 * 1024) throw new Error('Blockbench PNG size is invalid')
      const projectPath = await this.resolveProjectFile(normalized.projectRelativePath)
      const texturePath = await this.resolveProjectFile(normalized.textureRelativePath)
      const previousProject = await fs.readFile(projectPath).catch(() => null)
      const previousTexture = await fs.readFile(texturePath).catch(() => null)
      try {
        await fs.writeFile(projectPath, projectContent, 'utf8')
        await fs.writeFile(texturePath, textureContent)
      } catch (error) {
        await restoreFile(projectPath, previousProject)
        await restoreFile(texturePath, previousTexture)
        throw error
      }
      return {projectRelativePath: normalized.projectRelativePath, textureRelativePath: normalized.textureRelativePath, textureBytes: textureContent.length}
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // BrowserWindow emits `closed` after its native content view is gone.
    // Detaching the child in that phase throws "Object has been destroyed".
    if (this.attached && !this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(this.view)
      } catch {
        // The host may be tearing down concurrently; cleanup is best effort.
      }
    }
    this.attached = false
    this.listeners.clear()
    try {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    } catch {
      // WebContents can be destroyed by Electron before the bridge callback.
    }
    this.setStatus('destroyed', 'Blockbench bridge destroyed')
  }

  private async executeValidatedAction(action: BlockbenchAction): Promise<BlockbenchActionResult> {
    this.assertAlive()
    if (this.status.phase !== 'ready') throw new Error('Blockbench is not ready')

    if (action.type === 'save-project') {
      const pageResult = await this.invokePage({ type: 'serialize-project' })
      if (typeof pageResult.content !== 'string') throw new Error('Blockbench returned an invalid project')
      if (Buffer.byteLength(pageResult.content, 'utf8') > 50 * 1024 * 1024) {
        throw new Error('Blockbench project exceeds the 50 MiB save limit')
      }
      const destination = await this.resolveProjectFile(action.relativePath)
      await fs.writeFile(destination, pageResult.content, { encoding: 'utf8', flag: 'w' })
      return {
        action: action.type,
        success: true,
        message: 'Blockbench project saved',
        data: { relativePath: action.relativePath }
      }
    }

    if (action.type === 'export-model') {
      const pageResult = await this.invokePage({ type: 'serialize-export' })
      if (typeof pageResult.content !== 'string' || Buffer.byteLength(pageResult.content, 'utf8') > 50 * 1024 * 1024) {
        throw new Error('Blockbench returned an invalid or oversized model export')
      }
      const destination = await this.resolveProjectFile(action.relativePath)
      await fs.writeFile(destination, pageResult.content, { encoding: 'utf8', flag: 'w' })
      return { action: action.type, success: true, message: 'Blockbench model exported', data: { relativePath: action.relativePath } }
    }

    if (action.type === 'save-texture') {
      const pageResult = await this.invokePage({
        type: 'serialize-texture',
        textureUuid: action.textureUuid,
        textureName: action.textureName
      })
      if (typeof pageResult.content !== 'string' || !pageResult.content.startsWith('data:image/png;base64,')) {
        throw new Error('Blockbench returned an invalid PNG texture')
      }
      const encoded = pageResult.content.slice('data:image/png;base64,'.length)
      const content = Buffer.from(encoded, 'base64')
      if (!content.length || content.length > 8 * 1024 * 1024) throw new Error('Blockbench PNG size is invalid')
      const destination = await this.resolveProjectFile(action.relativePath)
      await fs.writeFile(destination, content, { flag: 'w' })
      return {
        action: action.type,
        success: true,
        message: 'Blockbench texture saved',
        data: { relativePath: action.relativePath, size: content.length }
      }
    }

    const pageResult = await this.invokePage(action)
    return {
      action: action.type,
      success: true,
      message: pageResult.message,
      data: pageResult.data as BlockbenchActionResult['data']
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.actionQueue.then(operation)
    this.actionQueue = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  private async readProjectState(): Promise<BlockbenchProjectState> {
    this.assertAlive()
    if (this.status.phase !== 'ready') throw new Error('Blockbench is not ready')
    const pageResult = await this.invokePage({ type: 'inspect-project' })
    const state = parseProjectState(pageResult.data)
    return { ...state, revision: projectStateRevision(state) }
  }

  private async captureValidatedViews(
    request: Required<BlockbenchCaptureRequest>,
    revision: string
  ): Promise<BlockbenchCaptureResult> {
    const pageResult = await this.invokePage({ type: 'capture-views', ...request })
    if (!Array.isArray(pageResult.captures) || pageResult.captures.length !== request.views.length) {
      throw new Error('Blockbench returned an invalid screenshot set')
    }
    const captures = pageResult.captures.map((capture, index) => {
      if (!isRecord(capture) || capture.view !== request.views[index]
        || capture.width !== request.width || capture.height !== request.height
        || typeof capture.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(capture.dataUrl)
        || capture.dataUrl.length > 12 * 1024 * 1024) {
        throw new Error('Blockbench returned an invalid screenshot')
      }
      return {
        view: request.views[index],
        width: request.width,
        height: request.height,
        dataUrl: capture.dataUrl
      }
    })
    return { revision, captures }
  }

  private async activeProjectUuid(): Promise<string | null> {
    const result = await this.invokePage({ type: 'active-project' })
    const projectUuid = result.data?.projectUuid
    return typeof projectUuid === 'string' && projectUuid ? projectUuid : null
  }

  private async createProjectSnapshot(): Promise<string> {
    const result = await this.invokePage({type: 'snapshot-project'})
    const token = result.data?.token
    if (typeof token !== 'string' || !token) throw new Error('Blockbench returned an invalid project snapshot')
    return token
  }

  private async restoreProjectSnapshot(token: string): Promise<void> {
    await this.invokePage({type: 'restore-project-snapshot', token})
  }

  private async discardProjectSnapshot(token: string): Promise<void> {
    await this.invokePage({type: 'discard-project-snapshot', token})
  }

  private async rememberCheckpoint(
    token: string,
    state: BlockbenchProjectState,
    actions: BlockbenchAction[],
    label?: string
  ): Promise<BlockbenchHistoryEntry> {
    const entry: BlockbenchHistoryEntry = {
      id: `bbh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      label: label ?? `Before ${actions.length === 1 ? actions[0].type : `${actions.length} edits`}`,
      createdAt: new Date().toISOString(), revision: state.revision,
      projectName: state.project.name, actionCount: actions.length
    }
    this.checkpoints.push({entry, token})
    while (this.checkpoints.length > 20) {
      const expired = this.checkpoints.shift()
      if (expired) await this.discardProjectSnapshot(expired.token)
    }
    return {...entry}
  }

  private async discardProject(projectUuid: string, restoreProjectUuid: string | null): Promise<void> {
    await this.invokePage({ type: 'discard-project', projectUuid, restoreProjectUuid: restoreProjectUuid ?? undefined })
  }

  private async discardCandidateProjects(projectUuids: string[], restoreProjectUuid: string | null): Promise<void> {
    for (const projectUuid of [...projectUuids].reverse()) {
      await this.discardProject(projectUuid, restoreProjectUuid)
    }
  }

  private async invokePage(
    action:
      | BlockbenchAction
      | { type: 'serialize-project' }
      | { type: 'serialize-export' }
      | { type: 'serialize-texture'; textureUuid?: string; textureName?: string }
      | { type: 'set-asset-metadata'; metadata: BlockbenchAssetMetadata }
      | { type: 'active-project' }
      | { type: 'snapshot-project' }
      | { type: 'restore-project-snapshot'; token: string }
      | { type: 'discard-project-snapshot'; token: string }
      | { type: 'clone-project' }
      | { type: 'discard-project'; projectUuid: string; restoreProjectUuid?: string }
      | { type: 'inspect-project' }
      | { type: 'capture-views'; views: BlockbenchViewPreset[]; width: number; height: number }
  ): Promise<PageActionResult> {
    const encoded = Buffer.from(JSON.stringify(action), 'utf8').toString('base64')
    const script = `(async()=>{const action=JSON.parse(atob(${JSON.stringify(encoded)}));return (${PAGE_DISPATCHER})(action)})()`
    const result: unknown = await this.view.webContents.executeJavaScript(script, true)
    if (!isRecord(result) || typeof result.message !== 'string') {
      throw new Error('Blockbench returned an invalid action result')
    }
    return result as unknown as PageActionResult
  }

  private async waitUntilReady(): Promise<string | undefined> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (this.destroyed) throw new Error('Blockbench 桥接在加载过程中被销毁')
      const probe: unknown = await this.view.webContents.executeJavaScript(
        `(() => {
          const root = globalThis;
          const bb = typeof Blockbench !== 'undefined' ? Blockbench : root.Blockbench;
          const formats = typeof Formats !== 'undefined' ? Formats : root.Formats;
          const cube = typeof Cube !== 'undefined' ? Cube : root.Cube;
          const texture = typeof Texture !== 'undefined' ? Texture : root.Texture;
          const codecs = typeof Codecs !== 'undefined' ? Codecs : root.Codecs;
          return {ready: !!(bb && formats && cube && texture && codecs && codecs.project), version: bb && bb.version};
        })()`,
        true
      )
      if (isRecord(probe) && probe.ready === true) {
        return typeof probe.version === 'string' ? probe.version : undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Blockbench 已加载，但编辑器 API 未就绪')
  }

  private async applyTheme(): Promise<void> {
    const palettes = {
      light: {
        back: '#ffffff',
        dark: '#f3f4f6',
        border: '#dfe1e5',
        ui: '#f7f8fa',
        accent: '#1677e8',
        button: '#ffffff',
        selected: '#dcecff',
        elevated: '#ffffff',
        frame: '#f3f4f6',
        text: '#34373d',
        light: '#202226',
        accent_text: '#ffffff',
        bright_ui_text: '#34373d',
        subtle_text: '#747881',
        bright_ui: '#ffffff',
        bright_border: '#b9bec7',
        grid: '#d8dce2',
        wireframe: '#5a7795',
        checkerboard: '#e3e6ea',
        menu_separator: '#c5c9d0',
        guidelines: 'rgba(70, 88, 105, 0.35)'
      },
      dark: {
        back: '#202125',
        dark: '#1c1d20',
        border: '#3b3e45',
        ui: '#242529',
        accent: '#2679d8',
        button: '#2b2d32',
        selected: '#35485b',
        elevated: '#2b2d32',
        frame: '#1c1d20',
        text: '#e7e7eb',
        light: '#f4f5f7',
        accent_text: '#ffffff',
        bright_ui_text: '#e7e7eb',
        subtle_text: '#aeb0b8',
        bright_ui: '#373a42',
        bright_border: '#5a5e67',
        grid: '#3b3e45',
        wireframe: '#79b5e5',
        checkerboard: '#18191c',
        menu_separator: '#555a64',
        guidelines: 'rgba(174, 182, 189, 0.35)'
      }
    } as const
    const palette = palettes[this.theme]
    const css = Object.entries(palette)
      .map(([name, value]) => `--color-${name}: ${value} !important;`)
      .join('')
    const script = `(() => {
      const id = 'modmind-blockbench-theme';
      let style = document.getElementById(id);
      if (!style) {
        style = document.createElement('style');
        style.id = id;
        document.head.appendChild(style);
      }
      const layoutCss = ${JSON.stringify(`#corner_logo, #web_download_button { display: none !important; } #menu_bar { padding: 0 4px !important; gap: 2px !important; } #menu_bar > li { padding: 0 6px !important; font-size: 12px !important; } #menu_bar > li > .menu_bar_selector { padding: 4px 6px !important; }`)};
      style.textContent = ${JSON.stringify(`body { ${css} }`)} + layoutCss;
      document.documentElement.style.colorScheme = ${JSON.stringify(this.theme)};
      document.body.dataset.modmindTheme = ${JSON.stringify(this.theme)};
      document.body.classList.toggle('light_mode', ${this.theme === 'light'});
      if (!window.__modmindMobileResize) {
        window.__modmindMobileResize = true;
        const updateMobile = () => { document.body.classList.toggle('is_mobile', window.innerWidth < 900); };
        window.addEventListener('resize', updateMobile);
        updateMobile();
      }
      if (globalThis.CustomTheme && CustomTheme.data && CustomTheme.data.colors) {
        Object.assign(CustomTheme.data.colors, ${JSON.stringify(palette)});
        if (typeof CustomTheme.updateColors === 'function') CustomTheme.updateColors();
      }
      if (globalThis.Canvas && typeof Canvas.updateAll === 'function') Canvas.updateAll();
    })()`
    await this.view.webContents.executeJavaScript(script, true)
  }

  private async resolveProjectFile(relativePath: string): Promise<string> {
    const projectRoot = this.getProjectRoot()
    if (!projectRoot) throw new Error('No ModMind project is open')
    const realRoot = await fs.realpath(projectRoot)
    const target = path.resolve(realRoot, relativePath)
    if (!isInside(realRoot, target)) throw new Error('Blockbench save path leaves the current project')

    const parent = path.dirname(target)
    await fs.mkdir(parent, { recursive: true })
    const realParent = await fs.realpath(parent)
    if (!isInside(realRoot, realParent)) throw new Error('Blockbench save path crosses a symbolic link')
    const existing = await fs.lstat(target).catch(() => null)
    if (existing?.isSymbolicLink()) throw new Error('Blockbench cannot overwrite a symbolic link')
    return target
  }

  private configureSecurity(): void {
    const entryDirectory = path.dirname(this.entryPath)
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.on('will-navigate', (event, url) => {
      if (!isLocalEntryUrl(url, entryDirectory)) event.preventDefault()
    })
    this.view.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
    })
  }

  private bindLifecycleEvents(): void {
    this.view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.setStatus('error', description)
    })
    this.view.webContents.on('render-process-gone', (_event, details) => {
      this.setStatus('error', `Blockbench renderer stopped: ${details.reason}`)
    })
  }

  private makeStatus(
    phase: BlockbenchBridgeStatus['phase'],
    visible: boolean,
    message?: string,
    version?: string
  ): BlockbenchBridgeStatus {
    return { phase, visible, message, version, updatedAt: new Date().toISOString() }
  }

  private setStatus(phase: BlockbenchBridgeStatus['phase'], message?: string, version?: string): void {
    this.status = this.makeStatus(phase, this.status.visible, message, version ?? this.status.version)
    this.emitStatus()
  }

  private updateVisibility(visible: boolean): void {
    this.status = { ...this.status, visible, updatedAt: new Date().toISOString() }
    this.emitStatus()
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) listener(status)
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Blockbench bridge has been destroyed')
  }
}

function validateActionBatch(actions: BlockbenchAction[], expectedRevision?: string): BlockbenchAction[] {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 500) {
    throw new Error('A Blockbench batch must contain between 1 and 500 actions')
  }
  const validated = actions.map((action) => validateAction(action))
  if (expectedRevision !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new Error('Blockbench expectedRevision is invalid')
  }
  return validated
}

function parseProjectState(value: unknown): Omit<BlockbenchProjectState, 'revision'> {
  if (!isRecord(value) || !isRecord(value.project) || !isRecord(value.format) || !isRecord(value.counts)
    || !Array.isArray(value.cubes) || !Array.isArray(value.groups) || !Array.isArray(value.meshes)
    || !Array.isArray(value.textures) || !Array.isArray(value.animations) || !Array.isArray(value.selection)) {
    throw new Error('Blockbench returned an invalid project state')
  }
  if (typeof value.project.uuid !== 'string' || typeof value.project.name !== 'string'
    || typeof value.format.id !== 'string' || typeof value.format.name !== 'string') {
    throw new Error('Blockbench returned incomplete project metadata')
  }
  return value as unknown as Omit<BlockbenchProjectState, 'revision'>
}

function validateAssetMetadata(value: BlockbenchAssetMetadata): BlockbenchAssetMetadata {
  if (!isRecord(value) || !['GENERATED', 'REFINED', 'MANUAL'].includes(String(value.source))) throw new Error('Blockbench asset metadata source is invalid')
  const boundedFields: Array<[keyof BlockbenchAssetMetadata, number]> = [['intentHash', 128], ['generatedAt', 64], ['refinedFrom', 128]]
  for (const [key, max] of boundedFields) {
    const item = value[key]
    if (item !== undefined && (typeof item !== 'string' || item.length > max)) throw new Error(`Blockbench asset metadata ${key} is invalid`)
  }
  if (value.intentHash !== undefined && !/^[a-f0-9]{64}$/.test(value.intentHash)) throw new Error('Blockbench asset metadata intentHash is invalid')
  return {
    source: value.source,
    ...(value.intentHash ? {intentHash: value.intentHash} : {}),
    ...(value.generatedAt ? {generatedAt: value.generatedAt} : {}),
    ...(value.refinedFrom ? {refinedFrom: value.refinedFrom} : {})
  }
}

function validateAssetSaveRequest(value: BlockbenchAssetSaveRequest): BlockbenchAssetSaveRequest {
  if (!isRecord(value) || typeof value.projectRelativePath !== 'string' || typeof value.textureRelativePath !== 'string' || typeof value.textureName !== 'string') throw new Error('Blockbench asset save request is invalid')
  return {
    projectRelativePath: normalizeBlockbenchPath(value.projectRelativePath, ['.bbmodel'], 'Blockbench project'),
    textureRelativePath: normalizeBlockbenchPath(value.textureRelativePath, ['.png'], 'Blockbench texture'),
    textureName: value.textureName,
    metadata: validateAssetMetadata(value.metadata)
  }
}

function parseProjectDocument(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new Error('Blockbench returned an invalid project document')
  }
}

async function restoreFile(target: string, content: Buffer | null): Promise<void> {
  if (content) await fs.writeFile(target, content)
  else await fs.rm(target, {force: true})
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function projectStateRevision(state: Omit<BlockbenchProjectState, 'revision'>): string {
  const projection = {
    ...state,
    project: { ...state.project, saved: undefined },
    animations: state.animations.map(({ selected: _selected, ...animation }) => animation),
    selection: undefined
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}`
}

export function validateCaptureRequest(request: BlockbenchCaptureRequest): Required<BlockbenchCaptureRequest> {
  if (!isRecord(request)) throw new Error('Blockbench capture request must be an object')
  const views = request.views ?? ['isometric_right', 'north', 'south', 'west']
  if (!Array.isArray(views) || views.length < 1 || views.length > 6
    || views.some((view) => !BLOCKBENCH_VIEW_PRESETS.includes(view as BlockbenchViewPreset))) {
    throw new Error('Blockbench capture views must contain between 1 and 6 supported camera presets')
  }
  if (new Set(views).size !== views.length) throw new Error('Blockbench capture views must be unique')
  const width = typeof request.width === 'number' ? request.width : 512
  const height = typeof request.height === 'number' ? request.height : 512
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 1024 || height > 1024) {
    throw new Error('Blockbench capture dimensions must be integers from 128 to 1024')
  }
  return { views: views as BlockbenchViewPreset[], width, height }
}

export function validateProjectState(state: BlockbenchProjectState): BlockbenchValidationResult {
  const findings: BlockbenchValidationFinding[] = []
  const add = (finding: BlockbenchValidationFinding): void => { findings.push(finding) }
  const groupIds = new Set(state.groups.map((group) => group.uuid))
  const boneIds = new Set((state.bones ?? []).map((bone) => bone.uuid))
  const armatureIds = new Set((state.armatures ?? []).map((armature) => armature.uuid))
  const parentIds = new Set([...groupIds, ...boneIds, ...armatureIds])
  const animationTargetIds = new Set([...groupIds, ...boneIds])
  const textureIds = new Set(state.textures.map((texture) => texture.uuid))
  const geometry = [...state.cubes, ...state.meshes]

  if (geometry.length === 0) {
    add({ severity: 'warning', checkId: 'empty-model', message: 'The project has no model geometry.' })
  }

  const checkDuplicateNames = (kind: string, entries: Array<{ uuid: string; name: string }>): void => {
    const seen = new Map<string, string>()
    for (const entry of entries) {
      const key = entry.name.trim().toLowerCase()
      if (!key) {
        add({ severity: 'warning', checkId: `unnamed-${kind}`, message: `A ${kind} has no name.`, targetUuid: entry.uuid })
        continue
      }
      if (seen.has(key)) {
        add({
          severity: 'warning', checkId: `duplicate-${kind}-name`,
          message: `Multiple ${kind}s are named "${entry.name}"; name-based AI edits would be ambiguous.`,
          targetUuid: entry.uuid, targetName: entry.name
        })
      } else {
        seen.set(key, entry.uuid)
      }
    }
  }
  checkDuplicateNames('group', state.groups)
  checkDuplicateNames('cube', state.cubes)
  checkDuplicateNames('mesh', state.meshes)

  for (const element of [...state.groups, ...geometry]) {
    if (element.parentUuid && !parentIds.has(element.parentUuid)) {
      add({
        severity: 'error', checkId: 'missing-parent-group',
        message: `${element.kind} "${element.name}" references a missing parent group.`,
        targetUuid: element.uuid, targetName: element.name
      })
    }
  }

  for (const mesh of state.meshes) {
    for (const face of Object.values(mesh.faces)) {
      if (face.vertices.length < 3 || face.vertices.some((vertex) => !(vertex in mesh.vertices))) {
        add({severity: 'error', checkId: 'invalid-mesh-topology', message: `Mesh "${mesh.name}" has an invalid face.`, targetUuid: mesh.uuid, targetName: mesh.name})
        break
      }
      if (face.textureUuid && !textureIds.has(face.textureUuid)) {
        add({severity: 'error', checkId: 'missing-mesh-texture-reference', message: `Mesh "${mesh.name}" references a missing texture.`, targetUuid: mesh.uuid, targetName: mesh.name})
        break
      }
      if (Object.keys(face.uv).length < face.vertices.length) {
        add({severity: 'warning', checkId: 'incomplete-mesh-uv', message: `Mesh "${mesh.name}" has a face without complete UV coordinates.`, targetUuid: mesh.uuid, targetName: mesh.name})
        break
      }
    }
  }

  for (const bone of state.bones ?? []) {
    if (bone.parentUuid && !boneIds.has(bone.parentUuid) && !armatureIds.has(bone.parentUuid)) {
      add({severity: 'error', checkId: 'missing-bone-parent', message: `Bone "${bone.name}" references a missing parent.`, targetUuid: bone.uuid, targetName: bone.name})
    }
    if (Object.values(bone.vertexWeights).some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)) {
      add({severity: 'error', checkId: 'invalid-vertex-weight', message: `Bone "${bone.name}" contains an invalid vertex weight.`, targetUuid: bone.uuid, targetName: bone.name})
    }
  }

  for (const target of state.ikTargets ?? []) {
    if (!target.targetUuid || !animationTargetIds.has(target.targetUuid) || !target.sourceUuid || !animationTargetIds.has(target.sourceUuid)) {
      add({severity: 'error', checkId: 'invalid-ik-reference', message: `IK target "${target.name}" references a missing target or source.`, targetUuid: target.uuid, targetName: target.name})
    }
  }

  const groupParents = new Map(state.groups.map((group) => [group.uuid, group.parentUuid]))
  for (const group of state.groups) {
    const visited = new Set<string>()
    let current: string | undefined = group.uuid
    while (current) {
      if (visited.has(current)) {
        add({
          severity: 'error', checkId: 'group-cycle', message: `Group "${group.name}" belongs to a parent cycle.`,
          targetUuid: group.uuid, targetName: group.name
        })
        break
      }
      visited.add(current)
      current = groupParents.get(current)
    }
  }

  for (const cube of state.cubes) {
    if (cube.from.some((value, index) => value >= cube.to[index])) {
      add({
        severity: 'error', checkId: 'invalid-cube-bounds', message: `Cube "${cube.name}" has invalid from/to bounds.`,
        targetUuid: cube.uuid, targetName: cube.name
      })
    }
    const enabledFaces = Object.values(cube.faces).filter((face) => face.enabled)
    const missingReferences = enabledFaces.filter((face) => face.textureUuid && !textureIds.has(face.textureUuid))
    const untextured = enabledFaces.filter((face) => !face.textureUuid)
    if (missingReferences.length) {
      add({
        severity: 'error', checkId: 'missing-texture-reference',
        message: `Cube "${cube.name}" has ${missingReferences.length} face(s) referencing a missing texture.`,
        targetUuid: cube.uuid, targetName: cube.name
      })
    }
    if (untextured.length) {
      add({
        severity: 'warning', checkId: 'untextured-faces',
        message: `Cube "${cube.name}" has ${untextured.length} enabled face(s) without a texture.`,
        targetUuid: cube.uuid, targetName: cube.name
      })
    }
    if (state.format.id === 'java_block' && [...cube.from, ...cube.to].some((value) => value < -16 || value > 32)) {
      add({
        severity: 'warning', checkId: 'java-block-display-bounds',
        message: `Cube "${cube.name}" extends beyond the usual Java block display range (-16 to 32).`,
        targetUuid: cube.uuid, targetName: cube.name
      })
    }
  }

  for (const texture of state.textures) {
    if (texture.width !== state.project.textureWidth || texture.height !== state.project.textureHeight) {
      add({
        severity: 'warning', checkId: 'texture-resolution-mismatch',
        message: `Texture "${texture.name}" is ${texture.width}x${texture.height}, while the project is ${state.project.textureWidth}x${state.project.textureHeight}.`,
        targetUuid: texture.uuid, targetName: texture.name
      })
    }
  }

  for (const animation of state.animations) {
    for (const animator of animation.animators) {
      if (!animationTargetIds.has(animator.targetUuid)) {
        add({
          severity: 'error', checkId: 'missing-animation-target',
          message: `Animation "${animation.name}" references a missing group.`,
          targetUuid: animation.uuid, targetName: animation.name
        })
      }
    }
  }

  const counts = findings.reduce<Record<BlockbenchValidationSeverity, number>>(
    (result, finding) => ({ ...result, [finding.severity]: result[finding.severity] + 1 }),
    { error: 0, warning: 0, info: 0 }
  )
  return { revision: state.revision, valid: counts.error === 0, findings, counts }
}

function validateBounds(bounds: BlockbenchBounds): Rectangle {
  const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height]
  if (!values.every((value) => Number.isInteger(value) && Number.isFinite(value))) {
    throw new Error('Blockbench bounds must be finite integers')
  }
  if (bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1) {
    throw new Error('Blockbench bounds must be positive and remain inside the window')
  }
  if (bounds.x > 16384 || bounds.y > 16384 || bounds.width > 16384 || bounds.height > 16384) {
    throw new Error('Blockbench bounds exceed the supported window size')
  }
  return { ...bounds }
}

function normalizeBlockbenchPath(value: unknown, extensions: string[], label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240) throw new Error(`Invalid ${label} path`)
  const normalized = value.replaceAll('\\', '/')
  const root = normalized.split('/')[0].toLowerCase()
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0') ||
    ['.git', '.modmind', 'node_modules', 'build', '.gradle'].includes(root) ||
    !extensions.some((extension) => normalized.toLowerCase().endsWith(extension))
  ) {
    throw new Error(`${label} path must be a safe project-relative ${extensions.join(' / ')} path`)
  }
  return normalized
}

export function validateAction(input: BlockbenchAction): BlockbenchAction {
  if (!isRecord(input) || typeof input.type !== 'string') throw new Error('Invalid Blockbench action')

  if (input.type === 'new-model') {
    assertOnlyKeys(input, ['type', 'format', 'name', 'textureWidth', 'textureHeight'])
    if (!BLOCKBENCH_FORMATS.includes(input.format as (typeof BLOCKBENCH_FORMATS)[number])) {
      throw new Error('Unsupported Blockbench format')
    }
    assertName(input.name, 'model name')
    assertOptionalTextureSize(input.textureWidth)
    assertOptionalTextureSize(input.textureHeight)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-cube') {
    assertOnlyKeys(input, ['type', 'name', 'from', 'to', 'origin', 'rotation', 'inflate', 'textureUuid', 'textureName', 'parentGroupUuid', 'parentGroupName'])
    assertName(input.name, 'cube name')
    assertVector(input.from, 'from', -1024, 1024)
    assertVector(input.to, 'to', -1024, 1024)
    if ((input.from as number[]).some((value, index) => value >= (input.to as number[])[index])) {
      throw new Error('Every cube from coordinate must be smaller than its to coordinate')
    }
    if (input.origin !== undefined) assertVector(input.origin, 'origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'rotation', -360, 360)
    if (input.inflate !== undefined) assertNumber(input.inflate, 'inflate', -64, 64)
    if (input.textureUuid !== undefined) assertIdentifier(input.textureUuid, 'texture UUID')
    if (input.textureName !== undefined) assertName(input.textureName, 'texture name')
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'parent group UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'parent group name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-group') {
    assertOnlyKeys(input, ['type', 'name', 'origin', 'rotation', 'parentGroupUuid', 'parentGroupName'])
    assertName(input.name, 'group name')
    if (input.origin !== undefined) assertVector(input.origin, 'origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'rotation', -360, 360)
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'parent group UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'parent group name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'update-cube') {
    assertOnlyKeys(input, ['type', 'cubeUuid', 'cubeName', 'from', 'to', 'origin', 'rotation', 'inflate'])
    if (input.cubeUuid === undefined && input.cubeName === undefined) throw new Error('update-cube requires cubeUuid or cubeName')
    if (input.cubeUuid !== undefined) assertIdentifier(input.cubeUuid, 'cube UUID')
    if (input.cubeName !== undefined) assertName(input.cubeName, 'cube name')
    if (input.from !== undefined) assertVector(input.from, 'from', -1024, 1024)
    if (input.to !== undefined) assertVector(input.to, 'to', -1024, 1024)
    if (input.from !== undefined && input.to !== undefined && input.from.some((value, index) => value >= input.to![index])) throw new Error('Every cube from coordinate must be smaller than its to coordinate')
    if (input.origin !== undefined) assertVector(input.origin, 'origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'rotation', -360, 360)
    if (input.inflate !== undefined) assertNumber(input.inflate, 'inflate', -64, 64)
    if ([input.from, input.to, input.origin, input.rotation, input.inflate].every((value) => value === undefined)) throw new Error('update-cube has no changes')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'update-group') {
    assertOnlyKeys(input, ['type', 'groupUuid', 'groupName', 'origin', 'rotation'])
    if (input.groupUuid === undefined && input.groupName === undefined) throw new Error('update-group requires groupUuid or groupName')
    if (input.groupUuid !== undefined) assertIdentifier(input.groupUuid, 'group UUID')
    if (input.groupName !== undefined) assertName(input.groupName, 'group name')
    if (input.origin !== undefined) assertVector(input.origin, 'origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'rotation', -360, 360)
    if (input.origin === undefined && input.rotation === undefined) throw new Error('update-group has no changes')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-mesh') {
    assertOnlyKeys(input, ['type', 'name', 'vertices', 'faces', 'origin', 'rotation', 'shading', 'parentGroupUuid', 'parentGroupName'])
    assertName(input.name, 'mesh name')
    validateMeshTopology(input.vertices, input.faces, true)
    if (input.origin !== undefined) assertVector(input.origin, 'mesh origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'mesh rotation', -360, 360)
    if (input.shading !== undefined && !['flat', 'smooth'].includes(String(input.shading))) throw new Error('Mesh shading is invalid')
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'mesh parent UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'mesh parent name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'update-mesh') {
    assertOnlyKeys(input, ['type', 'meshUuid', 'meshName', 'vertices', 'faces', 'origin', 'rotation', 'shading'])
    if (input.meshUuid === undefined && input.meshName === undefined) throw new Error('update-mesh requires meshUuid or meshName')
    if (input.meshUuid !== undefined) assertIdentifier(input.meshUuid, 'mesh UUID')
    if (input.meshName !== undefined) assertName(input.meshName, 'mesh name')
    if (input.vertices !== undefined) validateMeshVertices(input.vertices)
    if (input.faces !== undefined) validateMeshFaces(input.faces, input.vertices)
    if (input.faces !== undefined && input.vertices === undefined) {
      throw new Error('Replacing mesh faces also requires the complete vertex map')
    }
    if (input.origin !== undefined) assertVector(input.origin, 'mesh origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'mesh rotation', -360, 360)
    if (input.shading !== undefined && !['flat', 'smooth'].includes(String(input.shading))) throw new Error('Mesh shading is invalid')
    if ([input.vertices, input.faces, input.origin, input.rotation, input.shading].every((value) => value === undefined)) throw new Error('update-mesh has no changes')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'delete-elements') {
    assertOnlyKeys(input, ['type', 'elementUuids'])
    if (!Array.isArray(input.elementUuids) || input.elementUuids.length < 1 || input.elementUuids.length > 256) {
      throw new Error('delete-elements requires 1 to 256 element UUIDs')
    }
    input.elementUuids.forEach((uuid) => assertIdentifier(uuid, 'element UUID'))
    if (new Set(input.elementUuids).size !== input.elementUuids.length) throw new Error('delete-elements contains duplicate UUIDs')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'duplicate-element') {
    assertOnlyKeys(input, ['type', 'elementUuid', 'name', 'offset', 'parentGroupUuid', 'parentGroupName'])
    assertIdentifier(input.elementUuid, 'element UUID')
    assertName(input.name, 'duplicate name')
    if (input.offset !== undefined) assertVector(input.offset, 'duplicate offset', -1024, 1024)
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'duplicate parent UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'duplicate parent name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'rename-element') {
    assertOnlyKeys(input, ['type', 'elementUuid', 'name'])
    assertIdentifier(input.elementUuid, 'element UUID')
    assertName(input.name, 'element name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'reparent-element') {
    assertOnlyKeys(input, ['type', 'elementUuid', 'parentGroupUuid', 'parentGroupName', 'root'])
    assertIdentifier(input.elementUuid, 'element UUID')
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'parent UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'parent name')
    if (input.root !== undefined && typeof input.root !== 'boolean') throw new Error('reparent-element root must be boolean')
    const hasParent = input.parentGroupUuid !== undefined || input.parentGroupName !== undefined
    if ((input.root === true) === hasParent) throw new Error('reparent-element requires either root or one parent reference')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'update-cube-faces') {
    assertOnlyKeys(input, ['type', 'cubeUuid', 'cubeName', 'faces'])
    if (input.cubeUuid === undefined && input.cubeName === undefined) throw new Error('update-cube-faces requires cubeUuid or cubeName')
    if (input.cubeUuid !== undefined) assertIdentifier(input.cubeUuid, 'cube UUID')
    if (input.cubeName !== undefined) assertName(input.cubeName, 'cube name')
    if (!isRecord(input.faces) || Object.keys(input.faces).length < 1) throw new Error('update-cube-faces requires at least one face')
    const faceNames = new Set<BlockbenchFace>(['north', 'east', 'south', 'west', 'up', 'down'])
    for (const [faceName, update] of Object.entries(input.faces)) {
      if (!faceNames.has(faceName as BlockbenchFace) || !isRecord(update)) throw new Error('Cube face update is invalid')
      assertOnlyKeys(update, ['uv', 'rotation', 'textureUuid', 'textureName', 'enabled'])
      if (update.uv !== undefined) {
        if (!Array.isArray(update.uv) || update.uv.length !== 4) throw new Error('Cube face UV must have four coordinates')
        update.uv.forEach((coordinate) => assertNumber(coordinate, 'cube face UV', -1024, 1024))
      }
      if (update.rotation !== undefined && ![0, 90, 180, 270].includes(Number(update.rotation))) throw new Error('Cube face rotation is invalid')
      if (update.textureUuid !== undefined) assertIdentifier(update.textureUuid, 'face texture UUID')
      if (update.textureName !== undefined) assertName(update.textureName, 'face texture name')
      if (update.enabled !== undefined && typeof update.enabled !== 'boolean') throw new Error('Cube face enabled must be boolean')
      if (Object.keys(update).length < 1) throw new Error('Cube face update has no changes')
    }
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'paint-texture') {
    assertOnlyKeys(input, ['type', 'textureUuid', 'textureName', 'rectangles', 'strokes', 'paletteMap'])
    if (input.textureUuid === undefined && input.textureName === undefined) throw new Error('paint-texture requires textureUuid or textureName')
    if (input.textureUuid !== undefined) assertIdentifier(input.textureUuid, 'texture UUID')
    if (input.textureName !== undefined) assertName(input.textureName, 'texture name')
    if (input.rectangles !== undefined) validateTextureRectangles(input.rectangles, undefined, undefined, 512)
    if (input.strokes !== undefined) {
      if (!Array.isArray(input.strokes) || input.strokes.length > 256) throw new Error('Texture strokes must contain at most 256 entries')
      let pointCount = 0
      for (const stroke of input.strokes) {
        if (!isRecord(stroke)) throw new Error('Texture stroke must be an object')
        assertOnlyKeys(stroke, ['points', 'color', 'size'])
        if (!Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > 2048) throw new Error('Texture stroke must contain 1 to 2048 points')
        pointCount += stroke.points.length
        if (pointCount > 8192) throw new Error('Texture strokes contain too many points')
        stroke.points.forEach((point) => assertVector2(point, 'texture stroke point', 0, 1024))
        assertColor(stroke.color, 'texture stroke color')
        if (stroke.size !== undefined) assertNumber(stroke.size, 'texture stroke size', 1, 128)
      }
    }
    if (input.paletteMap !== undefined) {
      if (!isRecord(input.paletteMap) || Object.keys(input.paletteMap).length > 64) throw new Error('Texture palette map must contain at most 64 colors')
      for (const [from, to] of Object.entries(input.paletteMap)) {
        assertColor(from, 'source palette color')
        assertColor(to, 'target palette color')
      }
    }
    const changeCount = (input.rectangles?.length ?? 0) + (input.strokes?.length ?? 0) + Object.keys(input.paletteMap ?? {}).length
    if (changeCount < 1) throw new Error('paint-texture has no changes')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'auto-unwrap-mesh') {
    assertOnlyKeys(input, ['type', 'meshUuid', 'meshName', 'textureWidth', 'textureHeight', 'padding'])
    if (input.meshUuid === undefined && input.meshName === undefined) throw new Error('auto-unwrap-mesh requires meshUuid or meshName')
    if (input.meshUuid !== undefined) assertIdentifier(input.meshUuid, 'mesh UUID')
    if (input.meshName !== undefined) assertName(input.meshName, 'mesh name')
    if (input.textureWidth !== undefined) assertTextureSize(input.textureWidth, 'unwrap texture width')
    if (input.textureHeight !== undefined) assertTextureSize(input.textureHeight, 'unwrap texture height')
    if (input.padding !== undefined) assertNumber(input.padding, 'unwrap padding', 0, 64)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-armature') {
    assertOnlyKeys(input, ['type', 'name', 'origin'])
    assertName(input.name, 'armature name')
    if (input.origin !== undefined) assertVector(input.origin, 'armature origin', -1024, 1024)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-bone') {
    assertOnlyKeys(input, ['type', 'name', 'armatureUuid', 'armatureName', 'parentBoneUuid', 'parentBoneName', 'origin', 'rotation'])
    assertName(input.name, 'bone name')
    if (input.armatureUuid !== undefined) assertIdentifier(input.armatureUuid, 'armature UUID')
    if (input.armatureName !== undefined) assertName(input.armatureName, 'armature name')
    if (input.parentBoneUuid !== undefined) assertIdentifier(input.parentBoneUuid, 'parent bone UUID')
    if (input.parentBoneName !== undefined) assertName(input.parentBoneName, 'parent bone name')
    const armatureRef = input.armatureUuid !== undefined || input.armatureName !== undefined
    const boneRef = input.parentBoneUuid !== undefined || input.parentBoneName !== undefined
    if (armatureRef === boneRef) throw new Error('add-bone requires either an armature or a parent bone reference')
    if (input.origin !== undefined) assertVector(input.origin, 'bone origin', -1024, 1024)
    if (input.rotation !== undefined) assertVector(input.rotation, 'bone rotation', -360, 360)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'set-vertex-weights') {
    assertOnlyKeys(input, ['type', 'meshUuid', 'meshName', 'weights'])
    if (input.meshUuid === undefined && input.meshName === undefined) throw new Error('set-vertex-weights requires meshUuid or meshName')
    if (input.meshUuid !== undefined) assertIdentifier(input.meshUuid, 'mesh UUID')
    if (input.meshName !== undefined) assertName(input.meshName, 'mesh name')
    if (!isRecord(input.weights) || Object.keys(input.weights).length < 1 || Object.keys(input.weights).length > 4096) throw new Error('Vertex weights must contain 1 to 4096 vertices')
    for (const [vertex, entries] of Object.entries(input.weights)) {
      assertIdentifier(vertex, 'mesh vertex')
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 4) throw new Error('Each vertex requires 1 to 4 bone weights')
      const refs = new Set<string>()
      for (const entry of entries) {
        if (!isRecord(entry)) throw new Error('Vertex weight must be an object')
        assertOnlyKeys(entry, ['boneUuid', 'boneName', 'weight'])
        if (entry.boneUuid === undefined && entry.boneName === undefined) throw new Error('Vertex weight requires a bone reference')
        if (entry.boneUuid !== undefined) assertIdentifier(entry.boneUuid, 'bone UUID')
        if (entry.boneName !== undefined) assertName(entry.boneName, 'bone name')
        assertNumber(entry.weight, 'vertex weight', Number.EPSILON, 1)
        const ref = String(entry.boneUuid ?? entry.boneName)
        if (refs.has(ref)) throw new Error('Vertex contains duplicate bone weights')
        refs.add(ref)
      }
    }
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-locator') {
    assertOnlyKeys(input, ['type', 'name', 'position', 'parentGroupUuid', 'parentGroupName'])
    assertName(input.name, 'locator name')
    assertVector(input.position, 'locator position', -1024, 1024)
    if (input.parentGroupUuid !== undefined) assertIdentifier(input.parentGroupUuid, 'locator parent UUID')
    if (input.parentGroupName !== undefined) assertName(input.parentGroupName, 'locator parent name')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-ik-target') {
    assertOnlyKeys(input, ['type', 'name', 'position', 'targetGroupUuid', 'targetGroupName', 'sourceGroupUuid', 'sourceGroupName', 'lockRotation'])
    assertName(input.name, 'IK target name')
    assertVector(input.position, 'IK target position', -1024, 1024)
    if (input.targetGroupUuid !== undefined) assertIdentifier(input.targetGroupUuid, 'IK target UUID')
    if (input.targetGroupName !== undefined) assertName(input.targetGroupName, 'IK target name')
    if (input.sourceGroupUuid !== undefined) assertIdentifier(input.sourceGroupUuid, 'IK source UUID')
    if (input.sourceGroupName !== undefined) assertName(input.sourceGroupName, 'IK source name')
    if (input.targetGroupUuid === undefined && input.targetGroupName === undefined) throw new Error('add-ik-target requires a target reference')
    if (input.sourceGroupUuid === undefined && input.sourceGroupName === undefined) throw new Error('add-ik-target requires a source reference')
    if (input.lockRotation !== undefined && typeof input.lockRotation !== 'boolean') throw new Error('IK rotation lock must be boolean')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'set-asset-metadata') {
    assertOnlyKeys(input, ['type', 'metadata'])
    validateAssetMetadata(input.metadata)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-animation') {
    assertOnlyKeys(input, ['type', 'name', 'length', 'loop', 'snapping'])
    assertName(input.name, 'animation name')
    assertNumber(input.length, 'animation length', Number.EPSILON, 3600)
    if (input.loop !== undefined && !['once', 'loop', 'hold'].includes(String(input.loop))) throw new Error('Animation loop mode is invalid')
    if (input.snapping !== undefined && (!Number.isInteger(input.snapping) || input.snapping < 1 || input.snapping > 120)) throw new Error('Animation snapping must be an integer from 1 to 120')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'add-keyframe') {
    assertOnlyKeys(input, ['type', 'animationUuid', 'animationName', 'groupUuid', 'groupName', 'channel', 'time', 'value', 'interpolation'])
    const uuids = input.animationUuid !== undefined && input.groupUuid !== undefined
    const names = input.animationName !== undefined && input.groupName !== undefined
    if (!uuids && !names) throw new Error('Animation and group must be referenced by UUIDs or names')
    if (input.animationUuid !== undefined) assertIdentifier(input.animationUuid, 'animation UUID')
    if (input.animationName !== undefined) assertName(input.animationName, 'animation name')
    if (input.groupUuid !== undefined) assertIdentifier(input.groupUuid, 'group UUID')
    if (input.groupName !== undefined) assertName(input.groupName, 'group name')
    if (!['rotation', 'position', 'scale'].includes(String(input.channel))) throw new Error('Animation channel is invalid')
    assertNumber(input.time, 'keyframe time', 0, 3600)
    assertVector(input.value, 'keyframe value', -1024, 1024)
    if (input.interpolation !== undefined && !['linear', 'catmullrom', 'step', 'bezier'].includes(String(input.interpolation))) throw new Error('Keyframe interpolation is invalid')
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'create-texture') {
    assertOnlyKeys(input, ['type', 'name', 'width', 'height', 'dataUrl', 'fill', 'rectangles'])
    assertName(input.name, 'texture name')
    assertTextureSize(input.width, 'texture width')
    assertTextureSize(input.height, 'texture height')
    if (input.dataUrl !== undefined) {
      if (typeof input.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.dataUrl)) {
        throw new Error('Texture data must be a base64 PNG data URL')
      }
      if (input.dataUrl.length > 8 * 1024 * 1024) throw new Error('Texture data exceeds 8 MiB')
    }
    if (input.fill !== undefined && (typeof input.fill !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(input.fill))) {
      throw new Error('Texture fill must be #RRGGBB or #RRGGBBAA')
    }
    if (input.rectangles !== undefined) validateTextureRectangles(input.rectangles, input.width, input.height, 256)
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'set-cube-texture') {
    assertOnlyKeys(input, ['type', 'cubeUuid', 'textureUuid', 'cubeName', 'textureName', 'faces'])
    const hasUuids = input.cubeUuid !== undefined && input.textureUuid !== undefined
    const hasNames = input.cubeName !== undefined && input.textureName !== undefined
    if (!hasUuids && !hasNames) throw new Error('Cube and texture must be referenced by UUIDs or names')
    if (input.cubeUuid !== undefined) assertIdentifier(input.cubeUuid, 'cube UUID')
    if (input.textureUuid !== undefined) assertIdentifier(input.textureUuid, 'texture UUID')
    if (input.cubeName !== undefined) assertName(input.cubeName, 'cube name')
    if (input.textureName !== undefined) assertName(input.textureName, 'texture name')
    if (input.faces !== undefined) {
      const allowed = new Set<BlockbenchFace>(['north', 'east', 'south', 'west', 'up', 'down'])
      if (!Array.isArray(input.faces) || input.faces.length > 6 || !input.faces.every((face) => allowed.has(face as BlockbenchFace))) {
        throw new Error('Invalid cube face list')
      }
      if (new Set(input.faces).size !== input.faces.length) throw new Error('Cube face list contains duplicates')
    }
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'save-project') {
    assertOnlyKeys(input, ['type', 'relativePath'])
    return { type: input.type, relativePath: normalizeBlockbenchPath(input.relativePath, ['.bbmodel'], 'Blockbench project') }
  }

  if (input.type === 'export-model') {
    assertOnlyKeys(input, ['type', 'relativePath'])
    return { type: input.type, relativePath: normalizeBlockbenchPath(input.relativePath, ['.geo.json', '.json', '.java'], 'Blockbench export') }
  }

  if (input.type === 'run-command') {
    assertOnlyKeys(input, ['type', 'command'])
    const commands = new Set<BlockbenchCommand>([
      'undo',
      'redo',
      'frame-all',
      'toggle-grid',
      'toggle-animate',
      'mode-edit',
      'mode-paint',
      'mode-animate',
      'open-project',
      'save-project-dialog'
    ])
    if (typeof input.command !== 'string' || !commands.has(input.command as BlockbenchCommand)) {
      throw new Error('Unsupported Blockbench command')
    }
    return input as unknown as BlockbenchAction
  }

  if (input.type === 'save-texture') {
    assertOnlyKeys(input, ['type', 'relativePath', 'textureUuid', 'textureName'])
    const normalized = normalizeBlockbenchPath(input.relativePath, ['.png'], 'Blockbench texture')
    if (input.textureUuid === undefined && input.textureName === undefined) throw new Error('save-texture requires textureUuid or textureName')
    if (input.textureUuid !== undefined) assertIdentifier(input.textureUuid, 'texture UUID')
    if (input.textureName !== undefined) assertName(input.textureName, 'texture name')
    return input as unknown as BlockbenchAction
  }

  throw new Error(`Unsupported Blockbench action: ${String((input as { type?: unknown }).type)}`)
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new Error('Blockbench action contains unsupported fields')
  }
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\u0000-\u001f/\\]/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertVector(value: unknown, label: string, minimum: number, maximum: number): asserts value is BlockbenchVector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must have three coordinates`)
  value.forEach((coordinate) => assertNumber(coordinate, label, minimum, maximum))
}

function assertVector2(value: unknown, label: string, minimum: number, maximum: number): asserts value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must have two coordinates`)
  value.forEach((coordinate) => assertNumber(coordinate, label, minimum, maximum))
}

function assertColor(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    throw new Error(`${label} must be #RRGGBB or #RRGGBBAA`)
  }
}

function validateTextureRectangles(value: unknown, width: number | undefined, height: number | undefined, maximum: number): void {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Texture rectangles must contain at most ${maximum} entries`)
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error('Texture rectangle must be an object')
    assertOnlyKeys(entry, ['x', 'y', 'width', 'height', 'color'])
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isInteger(entry[key]) || typeof entry[key] !== 'number') throw new Error(`Texture rectangle ${key} must be an integer`)
    }
    const x = Number(entry.x)
    const y = Number(entry.y)
    const rectangleWidth = Number(entry.width)
    const rectangleHeight = Number(entry.height)
    if (x < 0 || y < 0 || rectangleWidth < 1 || rectangleHeight < 1) throw new Error('Texture rectangle dimensions are invalid')
    if ((width !== undefined && x + rectangleWidth > width) || (height !== undefined && y + rectangleHeight > height)) {
      throw new Error('Texture rectangle leaves the texture bounds')
    }
    assertColor(entry.color, 'texture rectangle color')
  }
}

function validateMeshVertices(value: unknown): asserts value is Record<string, BlockbenchVector3> {
  if (!isRecord(value)) throw new Error('Mesh vertices must be an object')
  const entries = Object.entries(value)
  if (entries.length < 3 || entries.length > 4096) throw new Error('Mesh requires 3 to 4096 vertices')
  for (const [key, coordinate] of entries) {
    assertIdentifier(key, 'mesh vertex key')
    assertVector(coordinate, `mesh vertex ${key}`, -1024, 1024)
  }
}

function validateMeshFaces(value: unknown, vertices?: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192) throw new Error('Mesh requires 1 to 8192 faces')
  const vertexKeys = isRecord(vertices) ? new Set(Object.keys(vertices)) : null
  const faceIds = new Set<string>()
  for (const face of value) {
    if (!isRecord(face)) throw new Error('Mesh face must be an object')
    assertOnlyKeys(face, ['id', 'vertices', 'uv', 'textureUuid', 'textureName'])
    if (face.id !== undefined) {
      assertIdentifier(face.id, 'mesh face ID')
      if (faceIds.has(face.id)) throw new Error('Mesh face IDs must be unique')
      faceIds.add(face.id)
    }
    if (!Array.isArray(face.vertices) || face.vertices.length < 3 || face.vertices.length > 64) throw new Error('Mesh face requires 3 to 64 vertices')
    face.vertices.forEach((vertex) => assertIdentifier(vertex, 'mesh face vertex'))
    if (new Set(face.vertices).size !== face.vertices.length) throw new Error('Mesh face contains duplicate vertices')
    if (vertexKeys && face.vertices.some((vertex) => !vertexKeys.has(vertex))) throw new Error('Mesh face references an unknown vertex')
    if (face.uv !== undefined) {
      if (!isRecord(face.uv)) throw new Error('Mesh face UV must be an object')
      for (const [vertex, uv] of Object.entries(face.uv)) {
        if (!face.vertices.includes(vertex)) throw new Error('Mesh face UV references a vertex outside the face')
        assertVector2(uv, 'mesh face UV', -1024, 1024)
      }
    }
    if (face.textureUuid !== undefined) assertIdentifier(face.textureUuid, 'mesh texture UUID')
    if (face.textureName !== undefined) assertName(face.textureName, 'mesh texture name')
  }
}

function validateMeshTopology(vertices: unknown, faces: unknown, requireFaces: boolean): void {
  validateMeshVertices(vertices)
  if (requireFaces || faces !== undefined) validateMeshFaces(faces, vertices)
}

function assertNumber(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside the supported range`)
  }
}

function assertTextureSize(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 1024) {
    throw new Error(`${label} must be an integer from 1 to 1024`)
  }
}

function assertOptionalTextureSize(value: unknown): void {
  if (value !== undefined) assertTextureSize(value, 'texture size')
}

function normalizeCheckpointLabel(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Blockbench checkpoint label must be a string')
  const normalized = value.trim()
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f]/.test(normalized)) throw new Error('Invalid Blockbench checkpoint label')
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isLocalEntryUrl(rawUrl: string, entryDirectory: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'file:') return false
    return isInside(entryDirectory, path.resolve(fileURLToPath(url)))
  } catch {
    return false
  }
}
