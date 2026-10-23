import { scopedFilePath } from '../../src/main/scopedFilePath'
import { ImageStudioService, type ImageStudioServiceOptions } from './src/main/imageStudioService'
import type { FeaturePluginInvocationContext, FeaturePluginRuntime } from '../../src/shared/featurePlugins'
import type { ImageProcessingOptions } from '../../src/shared/imageStudio'
import type { NativeFeatureHost } from '../../src/main/index'
import { dialog } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { isJavaLoader } from '../../src/shared/projectPlatform'
import { nativeActions } from '../sdk/native'

export function activate(options: ImageStudioServiceOptions & { host?: NativeFeatureHost }): ImageStudioService & FeaturePluginRuntime {
  const service = new ImageStudioService(options)
  const host = options.host
  const decode = (dataUrl: unknown) => {
    if (typeof dataUrl !== 'string') throw new Error('图片数据格式无效')
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片')
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('图片不能为空且不能超过 20 MB')
    return { bytes, extension: match[1] === 'jpeg' ? 'jpg' : match[1] }
  }
  const safeName = (value: unknown) => String(value || 'modmind-image').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'modmind-image'
  const actions = {
    info: (input: Record<string, unknown>) => service.describe(input.includeModels === true),
    generate: async (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => {
      context.signal?.throwIfAborted()
      const project = host?.requireProject()
      if (context.projectPath && project?.path !== context.projectPath) throw new Error('项目已经切换，请重新生成图片')
      const toolDirectory = (project?.toolDataDirectory ?? '.modmind').replaceAll('\\', '/')
      const outputRelative = path.posix.join(toolDirectory, 'image-studio', 'generated')
      if (project) {
        await scopedFilePath(project.path, toolDirectory)
        await scopedFilePath(project.path, outputRelative)
      }
      const generated = await service.generate(input, 'agent', context.signal)
      const files: string[] = []
      const assets: Array<{ path?: string; dataUrl?: string; handoffAvailable: boolean }> = []
      for (const [index, asset] of generated.assets.entries()) {
        let relative: string | undefined
        if (project) {
          const decoded = decode(asset.dataUrl)
          relative = path.posix.join(outputRelative, `${safeName(generated.jobId)}-${index + 1}.${decoded.extension}`)
          const output = await scopedFilePath(project.path, relative)
          await fs.mkdir(path.dirname(output), { recursive: true })
          await fs.writeFile(output, decoded.bytes)
          files.push(relative)
        }
        const handoffAvailable = asset.dataUrl.startsWith('data:image/') && asset.dataUrl.length <= 8 * 1024 * 1024
        assets.push({ ...(relative ? { path: relative } : {}), ...(handoffAvailable ? { dataUrl: asset.dataUrl } : {}), handoffAvailable })
      }
      const cancelled = context.signal?.aborted === true
      const error = generated.error ?? (cancelled ? '生成已停止，已完成的图片已保存' : undefined)
      return { success: !error, cancelled, jobId: generated.jobId, files, assets, credits: generated.credits, hosted: generated.hosted, revisedPrompt: generated.revisedPrompt, ...(error ? { error } : {}) }
    },
    perfectPixel: (input: Record<string, unknown>) => service.process('perfect-pixel', String(input.dataUrl), { perfectPixel: input.perfectPixel } as ImageProcessingOptions),
    removeBackground: (input: Record<string, unknown>) => service.process('remove-background', String(input.dataUrl))
  }
  const native = host ? nativeActions(host) : { actions: {}, handle: () => undefined }
  native.handle('image-studio:getSettings', () => service.getSettings())
  native.handle('image-studio:saveSettings', (_, input) => service.saveSettings(input))
  native.handle('image-studio:capabilities', () => service.capabilities())
  native.handle('image-studio:generate', (_, input) => service.generate(input, 'manual'))
  native.handle('image-studio:process', (_, operation, dataUrl, input) => service.process(operation, dataUrl, input))
  native.handle('image-studio:history', () => service.history())
  native.handle('image-studio:revealApiKey', () => service.revealApiKey())
  native.handle('image-studio:saveAsset', async (_, dataUrl, suggestedName) => {
    const { bytes, extension } = decode(dataUrl)
    const selected = await dialog.showSaveDialog({ defaultPath: `${safeName(suggestedName)}.${extension}`, filters: [{ name: 'Image', extensions: [extension] }] })
    if (selected.canceled || !selected.filePath) return null
    await fs.writeFile(selected.filePath, bytes)
    return selected.filePath
  })
  native.handle('image-studio:saveToProject', async (_, dataUrl, suggestedName) => {
    const project = host!.requireProject()
    host!.assertProjectMutationAllowed(project.path, '加入图片')
    const { bytes, extension } = decode(dataUrl)
    const directory = project.kind === 'modpack' ? 'overrides/modmind-images' : isJavaLoader(project.loader) ? `src/main/resources/assets/${project.namespace}/textures/modmind` : 'resource_pack/textures/modmind'
    const relative = `${directory}/${safeName(suggestedName)}.${extension}`
    const output = path.resolve(project.path, ...relative.split('/'))
    await fs.mkdir(path.dirname(output), { recursive: true })
    const canonical = path.relative(await fs.realpath(project.path), await fs.realpath(path.dirname(output)))
    if (canonical.startsWith('..') || path.isAbsolute(canonical)) throw new Error('图片目标通过链接指向项目外部')
    await fs.writeFile(output, bytes)
    return relative
  })
  return Object.assign(service, { actions: { ...actions, ...native.actions } })
}
