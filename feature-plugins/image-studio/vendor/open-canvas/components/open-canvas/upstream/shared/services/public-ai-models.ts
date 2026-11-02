import { AIMediaType } from "../../extensions/ai/types";
import type { AICreditScene } from "../lib/ai-credit-rules";
import { canvasCatalogSettings, canvasImageModels, canvasVideoModels } from "../../../../../lib/open-canvas/catalog";

export type PublicMediaType = AIMediaType.IMAGE | AIMediaType.VIDEO | AIMediaType.AUDIO | AIMediaType.MUSIC;
export interface PublicModelInfo { model: string; media_type: PublicMediaType; supported_scenes: AICreditScene[] }

export function listPublicModels({ mediaType }: { mediaType?: PublicMediaType } = {}): PublicModelInfo[] {
  const images: PublicModelInfo[] = canvasImageModels().map(model => ({ model, media_type: AIMediaType.IMAGE, supported_scenes: ["text-to-image", "image-to-image"] }));
  const videos: PublicModelInfo[] = canvasVideoModels().map(model => ({ model, media_type: AIMediaType.VIDEO, supported_scenes: ["text-to-video", "image-to-video"] }));
  return [...images, ...videos].filter(model => !mediaType || model.media_type === mediaType);
}

export function getPublicModelLabel(model: string) { return model; }

export function resolvePublicModelRoute({ publicModel, mediaType, scene, options }: {
  publicModel: string; mediaType: PublicMediaType; scene?: string | null; options?: unknown;
}) {
  const normalized = publicModel.trim();
  if (!normalized) return { ok: false as const, code: "invalid_model", message: "请先在 API 设置中选择模型" };
  const settings = canvasCatalogSettings();
  const supportedScenes: AICreditScene[] = mediaType === AIMediaType.IMAGE ? ["text-to-image", "image-to-image"] : mediaType === AIMediaType.VIDEO ? ["text-to-video", "image-to-video"] : ["text-to-audio"];
  const resolvedScene = (scene || supportedScenes[0]) as AICreditScene;
  if (!supportedScenes.includes(resolvedScene)) return { ok: false as const, code: "scene_not_supported", message: "当前模型不支持这个生成场景", supportedScenes };
  return {
    ok: true as const, publicModel: normalized, mediaType, scene: resolvedScene,
    provider: mediaType === AIMediaType.IMAGE ? settings.route : "replicate", model: normalized, supportedScenes,
    options: options && typeof options === "object" && !Array.isArray(options) ? options as Record<string, unknown> : {},
  };
}

export function getPublicModelMediaType(model: string): PublicMediaType | null { return listPublicModels().find(item => item.model === model)?.media_type ?? null; }
export function findPublicModelByInternalRoute({ model }: { provider: string; model: string }) { return model || null; }
