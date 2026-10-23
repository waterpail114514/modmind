import type { ComponentType } from 'react'

interface PageDeclaration { id: string; label: string; component: string }
interface RendererManifest { id: string; apiVersion: number; views?: PageDeclaration[] }
interface PageMetadata { id?: string; exportName?: string; component?: unknown }

/** Rewrite resource URLs while retaining native IPC values such as binary buffers and dates. */
export function previewResourceUrls(value: any, base: string): any {
  if (typeof value === 'string') return value.replace(/modmind-feature:\/\/([a-z][a-z0-9-]*)\//g, base + 'features/$1/')
  if (Array.isArray(value)) return value.map(item => previewResourceUrls(item, base))
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,previewResourceUrls(item, base)]))
  }
  return value
}

/** API 2 renderers may register a named export table without SDK metadata. */
export function resolvePreviewPages(manifest: RendererManifest, id: unknown, value: unknown): { id: string; label: string; component: ComponentType<any> }[] {
  if (id !== manifest.id) throw new Error(`页面注册的包 ID 不匹配：需要 ${manifest.id}，收到 ${String(id)}`)
  if (manifest.apiVersion !== 2) throw new Error('预览仅支持 API 2 功能包')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('页面注册内容必须为组件导出对象')
  const module = value as Record<string, unknown>
  if (module.apiVersion !== undefined && module.apiVersion !== manifest.apiVersion) throw new Error(`页面注册的 API 版本不匹配：需要 ${manifest.apiVersion}，收到 ${String(module.apiVersion)}`)
  const metadata = Array.isArray(module.pages) ? module.pages as PageMetadata[] : []
  return (manifest.views ?? []).map(view => {
    const page = metadata.find(page => page && (page.exportName ?? page.id) === view.component)
    const component = Object.prototype.hasOwnProperty.call(module, view.component) ? module[view.component] : page?.component
    if (typeof component !== 'function') throw new Error(`页面未导出：${view.component}（${view.id}）`)
    return { id: view.id, label: view.label, component: component as ComponentType<any> }
  })
}
