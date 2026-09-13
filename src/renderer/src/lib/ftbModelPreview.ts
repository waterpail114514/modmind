import * as THREE from 'three'
import { createMinecraftModel } from './minecraftModelScene'
import type { FtbQuestIconResult } from '../../../shared/types'

const cache = new Map<string, Promise<string>>()
let renderer: THREE.WebGLRenderer | undefined
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const vector = (value: unknown, fallback: number[]): number[] => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback
const radians = (value: number): number => value * Math.PI / 180

export function renderFtbModel(preview: NonNullable<FtbQuestIconResult['modelPreview']>): Promise<string> {
  const key = JSON.stringify(preview)
  const existing = cache.get(key)
  if (existing) return existing
  const task = render(preview).catch(error => { cache.delete(key); throw error })
  cache.set(key, task)
  while (cache.size > 128) cache.delete(cache.keys().next().value!)
  return task
}

async function render(preview: NonNullable<FtbQuestIconResult['modelPreview']>): Promise<string> {
  const { group, dispose } = await createMinecraftModel(preview)
  const scene = new THREE.Scene()
  scene.add(group)
  try {
    const gui = record(preview.display.gui), rotation = vector(gui.rotation, [30,225,0]), scale = vector(gui.scale, [.625,.625,.625]), translation = vector(gui.translation,[0,0,0])
    const pivot = new THREE.Group(); scene.remove(group); scene.add(pivot)
    group.position.set(-8,-8,-8); pivot.add(group)
    pivot.rotation.set(...rotation.map(radians) as [number,number,number]); pivot.scale.set(...scale as [number,number,number]); pivot.position.set(...translation as [number,number,number])
    const camera = new THREE.OrthographicCamera(-10,10,10,-10,.1,200); camera.position.set(0,0,80); camera.lookAt(0,0,0)
    renderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true })
    renderer.setSize(128,128); renderer.setClearColor(0,0); renderer.render(scene,camera)
    return renderer.domElement.toDataURL('image/png')
  } finally { dispose() }
}
