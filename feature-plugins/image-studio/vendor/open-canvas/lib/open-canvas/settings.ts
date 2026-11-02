export type ImageRoute = "official" | "ls" | "custom";
export type CanvasProviderSettings = { version: 1; route: ImageRoute; models: Record<ImageRoute,string>; catalogs: Record<ImageRoute,string[]>; textModel: string; videoModel: string };
export const IMAGE_ROUTE_LABELS: Record<ImageRoute,string> = {official:"账号额度",ls:"账号额度",custom:"自定义图片 API"};
export function defaultCanvasSettings(): CanvasProviderSettings { return {version:1,route:"official",models:{official:"",ls:"",custom:""},catalogs:{official:[],ls:[],custom:[]},textModel:"",videoModel:""}; }
export function loadCanvasSettings(_userId: string) { return defaultCanvasSettings(); }
export function saveCanvasSettings(_settings: CanvasProviderSettings) { /* Credentials are managed by the ModMind main process. */ }
