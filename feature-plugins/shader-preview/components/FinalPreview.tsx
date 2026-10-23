import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { preprocess } from '@shaderfrog/glsl-parser/preprocessor/index.js'
import { Moon, RotateCcw, Sun } from 'lucide-react'

export default function FinalPreview({ source }: { source: string }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [night, setNight] = useState(false), [reset, setReset] = useState(0), [error, setError] = useState('')
  useEffect(() => {
    const element = container.current
    if (!element) return
    setError('')
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined, frame = 0, observer: ResizeObserver | undefined
    const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [], targets: THREE.WebGLRenderTarget[] = []
    try {
      const fragment = preprocess(source)
      if (/\b(?:sampler3D|sampler2DShadow|samplerCube|image2D|buffer)\b/.test(fragment)
        || [...fragment.matchAll(/uniform\s+\w+\s+(\w+)/g)].some(match => !['colortex0', 'viewWidth', 'viewHeight', 'frameTimeCounter'].includes(match[1]))) throw new Error('此 final 程序依赖其他游戏缓冲或 uniform，请在 Iris 实例中验证')
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.domElement.setAttribute('aria-label', 'final 阶段三维测试场景')
      const canvas = renderer.domElement
      void crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)).then(bytes => { canvas.dataset.shaderSourceHash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('') }).catch(() => undefined)
      element.append(renderer.domElement)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(night ? 0x667b94 : 0xa8d7e8)
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120)
      camera.position.set(13, 10, 15)
      controls = new OrbitControls(camera, renderer.domElement)
      controls.target.set(0, 0.5, 0); controls.enableDamping = true; controls.minDistance = 5; controls.maxDistance = 90
      const light = new THREE.DirectionalLight(night ? 0xc4dfff : 0xfff2d1, night ? 0.9 : 1.8)
      light.position.set(night ? -8 : 8, 16, 6); scene.add(light, new THREE.AmbientLight(0xffffff, night ? 0.55 : 0.65))
      const cube = new THREE.BoxGeometry(1, 1, 1); geometries.push(cube)
      const colors = [0x617f3c, 0x819f52, 0x858b8b, 0xb5ac89]
      const groundMaterials = colors.map(color => new THREE.MeshLambertMaterial({ color })); materials.push(...groundMaterials)
      for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
        if (x > -2 && x < 3 && z > -4 && z < 4) continue
        const y = Math.floor((Math.sin(x * 0.65) + Math.cos(z * 0.55)) * 0.8)
        const mesh = new THREE.Mesh(cube, groundMaterials[Math.abs(x + z) % 4]); mesh.position.set(x, y, z); scene.add(mesh)
      }
      const waterGeometry = new THREE.PlaneGeometry(4, 8), waterMaterial = new THREE.MeshPhongMaterial({ color: 0x3d9fba, shininess: 80, transparent: true, opacity: 0.85 })
      geometries.push(waterGeometry); materials.push(waterMaterial)
      const water = new THREE.Mesh(waterGeometry, waterMaterial); water.rotation.x = -Math.PI / 2; water.position.set(0.5, -0.45, 0); scene.add(water)
      const pillar = new THREE.Mesh(cube, groundMaterials[2]); pillar.position.set(-3, 2.5, 0); pillar.scale.set(2, 4, 2); scene.add(pillar)
      const renderTarget = new THREE.WebGLRenderTarget(1, 1); targets.push(renderTarget)
      const outputScene = new THREE.Scene(), outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      const outputGeometry = new THREE.PlaneGeometry(2, 2); geometries.push(outputGeometry)
      const outputMaterial = new THREE.ShaderMaterial({
        uniforms: { colortex0: { value: renderTarget.texture }, viewWidth: { value: 1 }, viewHeight: { value: 1 }, frameTimeCounter: { value: 0 } },
        vertexShader: 'varying vec2 texcoord; void main(){texcoord=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: `#define main modmindFinalPass\n${fragment}\n#undef main\nvoid main(){modmindFinalPass();\n#include <colorspace_fragment>\n}`, depthTest: false, depthWrite: false
      }); materials.push(outputMaterial)
      outputScene.add(new THREE.Mesh(outputGeometry, outputMaterial))
      let compilationFailed = false
      renderer.debug.onShaderError = (gl, program, vertex, frag) => {
        compilationFailed = true
        setError([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(frag)].filter(Boolean).join('\n').slice(0, 3000))
      }
      observer = new ResizeObserver(() => {
        const width = element.clientWidth, height = element.clientHeight
        if (!width || !height || !renderer) return
        renderer.setSize(width, height); renderTarget.setSize(width, height)
        camera.aspect = width / height; camera.updateProjectionMatrix()
        const vertical = THREE.MathUtils.degToRad(camera.fov)
        const angle = Math.min(vertical, 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect))
        const direction = camera.position.clone().sub(controls!.target).normalize()
        camera.position.copy(controls!.target).add(direction.multiplyScalar(10 / Math.sin(angle / 2) * 1.05))
        controls!.update()
        outputMaterial.uniforms.viewWidth.value = width; outputMaterial.uniforms.viewHeight.value = height
      }); observer.observe(element)
      const started = performance.now()
      const render = () => {
        if (!renderer) return
        frame = requestAnimationFrame(render)
        controls?.update(); outputMaterial.uniforms.frameTimeCounter.value = (performance.now() - started) / 1000
        renderer.setRenderTarget(renderTarget); renderer.render(scene, camera)
        renderer.setRenderTarget(null); renderer.render(outputScene, outputCamera)
        if (!compilationFailed) renderer.domElement.dataset.shaderRendered = 'true'
      }; render()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); controls?.dispose(); geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); targets.forEach(value => value.dispose()); renderer?.dispose(); renderer?.domElement.remove() }
  }, [source, night, reset])
  return <div className="shader-preview-view">
    <div className="shader-preview-toolbar"><span>final 阶段预览 · 示例场景</span><div className="segmented-control"><button title="日间" aria-label="日间" className={!night ? 'active' : ''} onClick={() => setNight(false)}><Sun size={16} /></button><button title="夜间" aria-label="夜间" className={night ? 'active' : ''} onClick={() => setNight(true)}><Moon size={16} /></button></div><button className="icon-button" title="重置视角" onClick={() => setReset(value => value + 1)}><RotateCcw size={15} /></button></div>
    <div className="shader-scene" ref={container} />
    {error ? <pre className="shader-preview-error" role="alert">{error}</pre> : null}
    <div className="shader-status" role="status">完整渲染、阴影、水面与其他阶段以游戏验证为准</div>
  </div>
}
