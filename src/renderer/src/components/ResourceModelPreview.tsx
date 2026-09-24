import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Box, LoaderCircle, RotateCcw } from 'lucide-react'
import type { ResourceModelPreview as Preview } from '../../../shared/resourcePack'
import { createMinecraftModel } from '../lib/minecraftModelScene'
import ResourceImagePreview from './ResourceImagePreview'
import { createProjectModelScene } from '../lib/projectModelScene'
import type { ProjectModelPreview } from '../../../shared/projectModels'

export function ModelCanvas({ model, projectModel, interactive = true }: { model?: NonNullable<NonNullable<Preview['icon']>['modelPreview']>; projectModel?: ProjectModelPreview; interactive?: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const reset = useRef<() => void>(() => undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    const container = host.current!
    let cancelled = false
    let release: (() => void) | undefined
    setError('')
    const sceneModel = projectModel ? createProjectModelScene(projectModel) : createMinecraftModel(model!)
    void sceneModel.then(({ group, dispose }) => {
      if (cancelled) { dispose(); return }
      let renderer: THREE.WebGLRenderer | undefined
      let controls: OrbitControls | undefined
      let observer: ResizeObserver | undefined
      const cleanup = (): void => { observer?.disconnect(); controls?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); dispose() }
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        container.appendChild(renderer.domElement)
        const scene = new THREE.Scene()
        scene.add(group)
        scene.add(new THREE.HemisphereLight(0xffffff, 0x71808a, 2))
        const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(1, 2, 3); scene.add(light)
        group.updateMatrixWorld(true)
        const bounds = new THREE.Box3()
        group.traverseVisible(object => { if (object instanceof THREE.Mesh) bounds.union(new THREE.Box3().setFromObject(object)) })
        if (bounds.isEmpty()) throw new Error('模型没有可显示的几何体')
        const center = bounds.getCenter(new THREE.Vector3())
        const radius = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1)
        const camera = new THREE.PerspectiveCamera(40, 1, Math.max(.01, radius / 1000), radius * 100)
        controls = new OrbitControls(camera, renderer.domElement)
        controls.enabled = interactive
        controls.zoomSpeed = .65
        renderer.domElement.style.touchAction = interactive ? 'none' : 'pan-y'
        controls.target.copy(center)
        controls.minDistance = radius * .1
        controls.maxDistance = radius * 20
        camera.position.copy(center).add(new THREE.Vector3(1, .7, 1).normalize().multiplyScalar(radius * 1.8))
        controls.update(); controls.saveState()
        const draw = (): void => { renderer!.render(scene, camera) }
        const resize = (): void => {
          const { width, height } = container.getBoundingClientRect()
          if (!width || !height) return
          renderer!.setSize(width, height)
          camera.aspect = width / height; camera.updateProjectionMatrix(); draw()
        }
        controls.addEventListener('change', draw)
        reset.current = () => { controls!.reset(); draw() }
        observer = new ResizeObserver(resize); observer.observe(container); resize()
        release = cleanup
      } catch (error) { cleanup(); setError(reportClientFailure(error)) }
    }).catch(error => { if (!cancelled) setError(reportClientFailure(error)) })
    return () => { cancelled = true; reset.current = () => undefined; release?.() }
  }, [model, projectModel, interactive])
  return <div className="resource-model-view">
    {interactive ? <div className="resource-preview-controls"><span>拖动旋转 · 滚轮缩放 · 右键平移</span><button className="secondary-button" onClick={() => reset.current()}><RotateCcw size={15} />重置视角</button></div> : null}
    {error ? <div className="resource-pack-notice" role="alert">无法显示模型：{error}</div> : null}
    <div className="resource-model-canvas" ref={host} aria-label="模型三维预览" />
  </div>
}

export default function ResourceModelPreview({ projectPath, packId, file, revision, onOpenFile }: { projectPath: string; packId: string; file: string; revision: string; onOpenFile: (file: string) => void }): React.JSX.Element {
  const [result, setResult] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setResult(null); setError('')
    void window.modmind.resourcePacks.previewModel(projectPath, packId, file).then(value => { if (active) setResult(value) }).catch(error => { if (active) setError(reportClientFailure(error)) })
    return () => { active = false }
  }, [projectPath, packId, file, revision])
  const references = result?.localReferences ?? []
  return <div className="resource-model-preview">
    {!result && !error ? <div className="resource-pack-empty"><LoaderCircle className="spin" size={22} />正在解析模型和贴图…</div> : null}
    {result?.icon?.modelPreview ? <ModelCanvas model={result.icon.modelPreview} /> : result?.icon?.url ? <ResourceImagePreview src={result.icon.url} name={file} /> : error || result ? <div className="resource-pack-empty"><Box size={26} /><p>此模型暂时无法预览</p><small>{error || result?.reason}</small><p>可切换到源码检查引用，或在模型编辑器中打开。</p></div> : null}
    {result?.icon ? <div className="resource-preview-footnote">{result.icon.modelPreview ? '几何体预览；动态贴图、游戏光照和生物群系染色可能不同。' : '物品贴图预览；不包含游戏内动态显示效果。'}</div> : null}
    {references.length ? <details className="resource-preview-references"><summary>关联资源 · {new Set(references).size}</summary>{[...new Set(references)].map(reference => <button key={reference} onClick={() => onOpenFile(reference)}>{reference}</button>)}</details> : null}
  </div>
}
