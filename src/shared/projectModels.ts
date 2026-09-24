import type { FtbQuestIconResult } from './types'

export interface ProjectModelPreview {
  path: string
  name: string
  warnings: string[]
  blockbench?: { elements: Record<string, unknown>[]; outliner: unknown[]; boxUv?: boolean; resolution: { width: number; height: number }; textures: Record<string, string> }
  minecraft?: NonNullable<FtbQuestIconResult['modelPreview']>
}

export function projectModelReference(href: string, explicit = false): string | undefined {
  let value = href.trim()
  try {
    if (value.startsWith('modmind-model:')) { value = new URL(value).searchParams.get('path') ?? ''; explicit = true }
    else value = decodeURIComponent(value)
  } catch { return undefined }
  value = value.replaceAll('\\', '/')
  if (!value || /[\x00-\x1f]/.test(value) || value.startsWith('//')) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return undefined
  return /\.bbmodel$/i.test(value) || explicit && /\.json$/i.test(value) ? value : undefined
}

export const PROJECT_REPLY_MODELS_PROMPT = '回复可直接附带可旋转、缩放的 3D 模型预览：使用 [模型名称](modmind-model:?path=URL编码后的项目相对路径)。支持已保存的 Blockbench .bbmodel 和 Java 方块/物品模型 .json；优先引用带内嵌贴图的 .bbmodel。普通 .bbmodel 文件链接也会显示模型卡片。只引用已确认存在的项目文件；预览为静态模型，不能声称已播放动画或完成游戏内验证。只读灵感台可展示已有模型；新建、修改或保存模型仍由工作台在建模功能启用时完成。'
