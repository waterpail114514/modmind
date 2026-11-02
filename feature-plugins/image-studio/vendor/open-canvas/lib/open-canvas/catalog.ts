import { defaultCanvasSettings, type CanvasProviderSettings } from "./settings";

let settings = defaultCanvasSettings();
export function setCanvasCatalog(value: CanvasProviderSettings) { settings = value; }
export function canvasCatalogSettings() { return settings; }
export function canvasImageModels() {
  return [...new Set([settings.models[settings.route], ...settings.catalogs[settings.route]].filter(Boolean))];
}
export function canvasTextModels() { return settings.textModel ? [settings.textModel] : []; }
export function canvasVideoModels() { return settings.videoModel ? [settings.videoModel] : []; }
