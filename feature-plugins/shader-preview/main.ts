import { createHash } from 'node:crypto'
import type { NativeFeatureHost } from '../../src/main/index'
import { shaderFeatureContext } from '../shader-shared/src/main/shaderFeature'
import { expandedShader, shaderInventory } from '../shader-shared/src/main/shaderSourceService'

export function activate(options: { host: NativeFeatureHost }) {
  const host = options.host
  const { project, actions } = shaderFeatureContext(host)
  return {
    actions: actions({
      query: async (input, context) => {
        const current = project(context)
        if (input.operation === 'inventory') return shaderInventory(current)
        if (input.operation === 'preview') {
          const expanded = await expandedShader(current, 'shaders/final.fsh')
          return { ...expanded, scope: 'final-only', gameVerified: false }
        }
        if (input.operation !== 'preview-image') throw new Error('不支持的光影预览查询')
        const window = host.mainWindow
        if (!window || window.isDestroyed()) throw new Error('请先打开当前工程的效果预览页面')
        const canvas = await window.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('.shader-scene canvas');
          if (!canvas || canvas.dataset.shaderRendered !== 'true' || canvas.closest('[hidden]') || document.querySelector('.shader-preview-error') || document.querySelector('[role="dialog"]')) return null;
          const rect = canvas.getBoundingClientRect();
          return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.round(rect.width), height: Math.round(rect.height), hash: canvas.dataset.shaderSourceHash, projectPath: canvas.closest('.shader-workspace')?.dataset.projectPath };
        })()`)
        if (!canvas?.width || !canvas.height) throw new Error('请先打开当前工程的效果预览页面')
        if (canvas.projectPath !== current.path) throw new Error('可见预览属于其他项目，未读取该画面')
        const expanded = await expandedShader(current, 'shaders/final.fsh')
        const hash = createHash('sha256').update(expanded.source).digest('hex')
        if (canvas.hash !== hash) throw new Error('预览对应旧源码或尚未就绪，请刷新预览后重试')
        const image = await window.webContents.capturePage({ x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height })
        if (image.isEmpty()) throw new Error('预览截图暂不可读取，请刷新后重试')
        const latestCanvasProject = await window.webContents.executeJavaScript(`document.querySelector('.shader-scene canvas')?.closest('.shader-workspace')?.dataset.projectPath`)
        if (latestCanvasProject !== current.path) throw new Error('截图时可见项目已切换，请重试')
        if (host.requireProject().path !== current.path || createHash('sha256').update((await expandedShader(current, 'shaders/final.fsh')).source).digest('hex') !== hash) throw new Error('截图时项目或源码已变化，请重试')
        return { scope: 'final-only', gameVerified: false, sourceHash: hash, dataUrl: image.resize({ width: Math.min(canvas.width, 1024) }).toDataURL() }
      }
    })
  }
}
