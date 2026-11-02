import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {generateCanvasImages,canvasImageSize} from '../../../../feature-plugins/image-studio/vendor/open-canvas/lib/open-canvas/transport'
import {defaultCanvasSettings} from '../../../../feature-plugins/image-studio/vendor/open-canvas/lib/open-canvas/settings'
import {createDefaultCanvasNodeData,normalizeCanvasNodeData,applyCanvasNodePatch,type CanvasImageNodeData} from '../../../../feature-plugins/image-studio/vendor/open-canvas/components/open-canvas/upstream/shared/lib/canvas/types'
import {parseCanvasDocument,exportCanvasDocument} from '../../../../feature-plugins/image-studio/vendor/open-canvas/lib/open-canvas/document'
import {migrateImageWorkflow} from '../../../../feature-plugins/image-studio/src/renderer/src/lib/imageCanvasMigration'
import {OpenCanvasRuntime} from '../../../../feature-plugins/image-studio/vendor/open-canvas/lib/open-canvas/runtime'
const {generate}=vi.hoisted(()=>({generate:vi.fn()}))
vi.mock('../../../../feature-plugins/image-studio/src/renderer/src/lib/imageStudioTrace',()=>({tracedImageStudio:()=>({generate})}))
const node=()=>({...createDefaultCanvasNodeData('image','zh'),model:'custom-image',count:3,quality:'high',aspectRatio:'16:9',resolution:'2K'}) as CanvasImageNodeData
beforeEach(()=>{generate.mockReset();generate.mockResolvedValue({assets:[],credits:0,hosted:false,jobId:'test'})})
afterEach(()=>vi.unstubAllGlobals())
describe('ModMind canvas adapter',()=>{
  it('handles local canvas routes in a packaged Electron file URL without a network request',async()=>{
    vi.stubGlobal('window',{location:{origin:'null'}})
    const canvas={id:'local-canvas',graph:{version:1,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}}
    const response=await OpenCanvasRuntime.prototype.request.call({ready:Promise.resolve(),database:{get:async()=>canvas}} as any,'/api/canvas/local-canvas')
    expect(await response.json()).toMatchObject({code:0,data:{canvas:{id:'local-canvas'}}})
  })
  it('uses the existing batch service with all parameters and never sends credentials',async()=>{
    await generateCanvasImages({settings:defaultCanvasSettings(),node:node(),prompt:'test',references:[],signal:new AbortController().signal})
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({prompt:'test',model:'custom-image',count:3,quality:'high',size:canvasImageSize(node()),removeBackground:false,source:'manual'}))
    expect(generate.mock.calls[0][0]).not.toHaveProperty('apiKey')
    expect(generate.mock.calls[0][0]).not.toHaveProperty('baseUrl')
  })
  it('keeps partial successful results when the later image fails',async()=>{
    const result={assets:[{id:'first',dataUrl:'data:image/png;base64,AA=='}],error:'second image failed',jobId:'partial',credits:1,hosted:true}
    generate.mockResolvedValue(result)
    expect(await generateCanvasImages({settings:defaultCanvasSettings(),node:node(),prompt:'test',references:[],signal:new AbortController().signal})).toBe(result)
    expect(generate).toHaveBeenCalledTimes(1)
  })
  it('does not submit a canceled queued task',async()=>{
    const controller=new AbortController();controller.abort()
    await expect(generateCanvasImages({settings:defaultCanvasSettings(),node:node(),prompt:'test',references:[],signal:controller.signal})).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
  it.each(['1:1','16:9','9:16','4:3','3:4'])('keeps 4K %s within the existing service size bounds',ratio=>{
    const [w,h]=canvasImageSize({...node(),aspectRatio:ratio,resolution:'4K'}).split('x').map(Number)
    expect(w%16).toBe(0);expect(h%16).toBe(0);expect(Math.max(w,h)).toBeLessThanOrEqual(3840);expect(w*h).toBeLessThanOrEqual(8_294_400)
  })
  it('persists batch and quality fields through JSON import/export without restarting jobs',()=>{
    const data={...node(),status:'running',lastRunId:'external-run'}
    const graph={version:1 as const,viewport:{x:0,y:0,zoom:1},nodes:[{id:'image',type:'image' as const,position:{x:0,y:0},data}],edges:[]}
    const parsed=parseCanvasDocument(exportCanvasDocument('saved',graph))
    expect(parsed.graph.nodes[0].data).toMatchObject({count:3,quality:'high',status:'idle',lastRunId:null})
  })
  it('keeps the original reference when a batch replaces the displayed image',()=>{
    const reference={url:'data:image/png;base64,AA==',source:'uploaded' as const}
    const output={url:'data:image/png;base64,AQ==',source:'generated' as const}
    const graph={version:1 as const,viewport:{x:0,y:0,zoom:1},nodes:[{id:'image',type:'image' as const,position:{x:0,y:0},data:{...node(),image:reference,referenceImage:reference}}],edges:[]}
    const updated=applyCanvasNodePatch(graph,{nodeId:'image',image:output,imageOutputs:[output]})!
    expect(normalizeCanvasNodeData('image',updated.nodes[0].data)).toMatchObject({referenceImage:reference,image:output,count:3})
  })
  it('converts previous prompt, reference and result nodes while leaving the old workflow untouched',()=>{
    const old:any={id:'old',name:'旧作品',updatedAt:'',nodes:[{id:'p',position:{x:0,y:0},data:{kind:'prompt',title:'提示词',prompt:'蓝色水晶'}},{id:'g',position:{x:300,y:0},data:{kind:'generate',title:'生图',count:4,quality:'high'}},{id:'process',position:{x:600,y:0},data:{kind:'process',title:'处理',operation:'perfect-pixel'}}],edges:[{id:'pg',source:'p',target:'g'},{id:'gp',source:'g',target:'process'}]}
    const original=JSON.stringify(old),converted=migrateImageWorkflow(old)
    expect(converted.graph.nodes).toHaveLength(2);expect(converted.graph.nodes[0].data).toMatchObject({plainText:'蓝色水晶'});expect(converted.graph.nodes[1].data).toMatchObject({count:4,quality:'high'})
    expect(()=>parseCanvasDocument(converted)).not.toThrow();expect(JSON.stringify(old)).toBe(original)
  })
})
