import type { CanvasProviderSettings } from "./settings";
import type { CanvasImageNodeData } from "../../components/open-canvas/upstream/shared/lib/canvas/types";
import { tracedImageStudio } from "../../../../src/renderer/src/lib/imageStudioTrace";
export async function checkedResponse(response:Response) { if (!response.ok) throw new Error('无法读取图片'); return response; }
export async function imageBlob(url:string, signal?:AbortSignal):Promise<Blob> {
  if (!/^(data:image\/|blob:)/i.test(url)) throw new Error('请先导入本地图片作为参考图');
  const blob = await (await checkedResponse(await fetch(url,{signal}))).blob();
  if (!blob.type.startsWith('image/') || !blob.size || blob.size > 20*1024*1024) throw new Error('图片格式无效或超过 20 MB');
  return blob;
}
export async function blobDataUrl(blob:Blob):Promise<string> { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(blob);}); }
export async function referenceBlob(url:string,signal?:AbortSignal) { return imageBlob(url,signal); }
export function canvasImageSize(node:Pick<CanvasImageNodeData,'aspectRatio'|'resolution'>) {
  if (node.aspectRatio==='auto') return 'auto';
  const [w,h]=node.aspectRatio.split(':').map(Number); const ratio=w>0&&h>0?w/h:1;
  const base=({"1K":1024,"2K":2048,"4K":3840} as Record<string,number>)[node.resolution]??1024;
  const area=Math.min(base*base,8_294_400,3840*3840/Math.max(ratio,1/ratio));
  const rounded=(n:number)=>Math.max(16,Math.floor(n/16)*16);
  return rounded(Math.sqrt(area*ratio))+'x'+rounded(Math.sqrt(area/ratio));
}
export async function readCanvasModels(_settings?:CanvasProviderSettings) { const capability=await tracedImageStudio().capabilities(); return {models:capability.models,provider:'modmind',message:''}; }
export async function generateCanvasImages({node,prompt,references,signal}:{settings:CanvasProviderSettings;node:CanvasImageNodeData;prompt:string;references:string[];signal:AbortSignal}) {
  signal.throwIfAborted();
  if(references.length>16) throw new Error('每次最多使用 16 张参考图');
  const referenceImages=await Promise.all(references.map(async url=>blobDataUrl(await referenceBlob(url,signal))));
  signal.throwIfAborted();
  return tracedImageStudio().generate({prompt,model:node.model,style:node.style??'free',size:canvasImageSize(node),quality:node.quality??'medium',moderation:node.moderation??'auto',count:node.count??1,background:'auto',backgroundColor:'#ffffff',removeBackground:false,source:'manual',...(referenceImages.length?{referenceImages}:{}),...(node.presetId?{presetId:node.presetId,presetPrompt:node.presetPrompt}:{})});
}
