import { activate as createPreview } from '../../vendor/mc-offline-tool/preview-feature/backend/main.js'
import { bindProjectRuntime } from '../../vendor/mc-offline-tool/src/host-runtime.mjs'
import { BrowserWindow } from 'electron'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'
// @ts-expect-error The shared viewer core is JavaScript.
import { queryDocuments, changeDocument } from '../../vendor/mc-offline-tool/src/structure-store.mjs'

export function activate() {
  return bindProjectRuntime({ ...createPreview(), preview_documents: queryDocuments, preview_save: changeDocument,
    preview_capture: async (input: { projectPath: string; id: string }, context: FeaturePluginInvocationContext) => {
      const { document } = queryDocuments(input)
      for (const window of BrowserWindow?.getAllWindows?.() ?? []) {
        if (window.isDestroyed()) continue
        const scene = await window.webContents.executeJavaScript(`(() => {
          const host = document.querySelector('.mcp-host');
          if(!host || host.dataset.projectPath !== ${JSON.stringify(context.projectPath)} || host.dataset.documentId !== ${JSON.stringify(input.id)} || host.dataset.dirty !== 'false' || host.dataset.sceneReady !== 'true') return null;
          const canvas = host.shadowRoot?.getElementById('stage');
          if(!canvas || !canvas.getClientRects().length) return null;
          const rect = canvas.getBoundingClientRect();
          return {revision:Number(host.dataset.revision),renderWarnings:JSON.parse(host.dataset.renderWarnings || '[]'),rect:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.floor(rect.width),height:Math.floor(rect.height)}};
        })()`).catch(() => null)
        if (!scene || scene.revision !== document.revision || scene.rect.width < 1 || scene.rect.height < 1) continue
        const png = await window.webContents.capturePage(scene.rect)
        return { status: 'captured', id: input.id, revision: document.revision, blocks: document.build.blocks.length, dataUrl: png.toDataURL(), renderWarnings: scene.renderWarnings, gameVerified: false }
      }
      throw new Error('请在当前项目打开该建筑的 3D 预览并保存后重试；当前没有与已保存版本一致的可见视口')
    }
  })
}
