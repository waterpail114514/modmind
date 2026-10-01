type NativeFunction = (...args: any[]) => any
let resolveNativeService: ((id: string) => Record<string, unknown>) | undefined

export function configureNativeFeatureServices(resolve: (id: string) => Record<string, unknown>): void {
  resolveNativeService = resolve
}

export function nativeFeatureFunction<T extends NativeFunction>(id: string, name: string): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const service = resolveNativeService?.(id)
    const handler = service?.[name]
    if (typeof handler !== 'function') throw new Error(`应用功能插件 ${id} 未提供 ${name}，请安装并启用该功能插件`)
    return handler.apply(service, args)
  }) as T
}
