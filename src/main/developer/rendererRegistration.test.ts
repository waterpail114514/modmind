import { describe, expect, it } from 'vitest'
import { resolvePreviewPages, previewResourceUrls } from '../../shared/developerRenderer'

const first = () => null, second = () => null
const manifest = { id: 'mc-preview', apiVersion: 2, views: [{ id: 'preview', label: '3D 场景预览', component: 'PreviewWorkspace' }] }

describe('independent renderer registration compatibility', () => {
  it('rewrites native asset URLs without changing binary, date or map IPC values', () => {
    const bytes = new Uint8Array([1,2,255]), buffer = bytes.buffer, date = new Date(), map = new Map([['key','value']])
    const result = previewResourceUrls({ image:'modmind-feature://fixture/assets/image.png',nested:[{bytes,buffer,date,map}],count:3 },'modmind-dev-preview://fixture/token/')
    expect(result.image).toBe('modmind-dev-preview://fixture/token/features/fixture/assets/image.png')
    expect(result.nested[0]).toMatchObject({bytes,buffer,date,map})
    expect(result.nested[0].bytes).toBe(bytes);expect(result.nested[0].buffer).toBe(buffer);expect(result.nested[0].date).toBe(date);expect(result.nested[0].map).toBe(map)
  })
  it('resolves a native API 2 export table without optional SDK version or pages metadata', () => {
    expect(resolvePreviewPages(manifest, 'mc-preview', { PreviewWorkspace: first })).toEqual([{ id: 'preview', label: '3D 场景预览', component: first }])
  })
  it('uses manifest page identities and order, including metadata with different local IDs', () => {
    const contract = { ...manifest, views: [...manifest.views, { id: 'second-route', label: '第二页', component: 'Second' }] }
    const pages = resolvePreviewPages(contract, contract.id, { apiVersion: 2, pages: [{ id: 'local-second', exportName: 'Second', component: second }, { id: 'local-first', exportName: 'PreviewWorkspace', component: first }] })
    expect(pages.map(page => [page.id, page.label, page.component])).toEqual([['preview', '3D 场景预览', first], ['second-route', '第二页', second]])
  })
  it('keeps explicit named exports authoritative and rejects missing or invalid components', () => {
    expect(resolvePreviewPages(manifest, manifest.id, { PreviewWorkspace: second, pages: [{ id: 'preview', exportName: 'PreviewWorkspace', component: first }] })[0].component).toBe(second)
    expect(() => resolvePreviewPages(manifest, manifest.id, { pages: [] })).toThrow('页面未导出：PreviewWorkspace')
    expect(() => resolvePreviewPages(manifest, manifest.id, { PreviewWorkspace: 1 })).toThrow('页面未导出')
    expect(() => resolvePreviewPages({ ...manifest, views: [{ ...manifest.views[0], component: 'toString' }] }, manifest.id, {})).toThrow('页面未导出')
  })
  it('reports ID and version mismatches separately and rejects malformed registrations', () => {
    expect(() => resolvePreviewPages(manifest, 'different', { PreviewWorkspace: first })).toThrow('包 ID 不匹配')
    expect(() => resolvePreviewPages(manifest, manifest.id, { apiVersion: 1, PreviewWorkspace: first })).toThrow('API 版本不匹配')
    expect(() => resolvePreviewPages({ ...manifest, apiVersion: 1 }, manifest.id, {})).toThrow('仅支持 API 2')
    for (const value of [null, undefined, [], 2, 'text']) expect(() => resolvePreviewPages(manifest, manifest.id, value)).toThrow('组件导出对象')
  })
})
