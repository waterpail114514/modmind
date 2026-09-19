import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { ScrollArea } from './AppScrollbars'

const categories = [
  { id: 'general', label: '通用', description: '调整外观、通知与日常使用偏好。' },
  { id: 'ai', label: 'AI 与图像', description: '选择适合你的模型，管理图像服务与执行审批。' },
  { id: 'development', label: '开发与构建', description: '管理 Java 环境、本地构建与远程构建。' },
  { id: 'integrations', label: '集成', description: '连接外部 Agent、MCP 客户端与网络代理。' },
  { id: 'about', label: '关于', description: '查看许可证，或导出日志帮助排查问题。' }
] as const

const sections = [
  { id: 'settings-appearance', category: 'general', keywords: '外观 主题 配色 颜色 ModMind 默认 中性 暖砂 青绿 石墨 深色模式 暗色模式 浅色模式 自定义 背景 图片 视频 本地 手动 调色 强调色 可见度 模糊 壁纸 dark theme wallpaper' },
  { id: 'settings-sidebar-order', category: 'general', keywords: '外观 侧边栏顺序 侧栏排序 重置侧栏 恢复默认顺序 sidebar' },
  { id: 'settings-notifications', category: 'general', keywords: '通知 关闭窗口 系统托盘 最小化 后台 任务完成通知 notification' },
  { id: 'settings-ai', category: 'ai', keywords: 'AI 模型 思考强度 推理 快速模式 Fast 模式 model' },
  { id: 'settings-image', category: 'ai', keywords: '图片模型 图像服务 自定义图像 API Key Base URL 模型 额度 图像工坊 image' },
  { id: 'settings-approval', category: 'ai', keywords: '执行审批 审批模式 权限 沙箱 自动审批 YOLO Codex' },
  { id: 'settings-java', category: 'development', keywords: 'Java JDK 游戏运行时 Minecraft Gradle 构建 JDK 编译 内置工具 JAVA_HOME' },
  { id: 'settings-build', category: 'development', keywords: '本地构建 构建工具 Gradle Wrapper 编译' },
  { id: 'settings-remote', category: 'development', keywords: '远程构建 云 Gitee Go 仓库地址 构建分支 Token 流水线' },
  { id: 'settings-agents', category: 'integrations', keywords: '外部 Agent Codex Claude Code 配置 安装 API Key Base URL 模型' },
  { id: 'settings-mcp', category: 'integrations', keywords: 'MCP 接入 外部 MCP 桥接 本机客户端 配置' },
  { id: 'settings-network', category: 'integrations', keywords: '网络 下载代理 HTTP 代理地址 网络代理 proxy' },
  { id: 'settings-legal', category: 'about', keywords: '许可证 版权 版本 源码 开源 AGPL MIT license 第三方 声明' },
  { id: 'settings-diagnostics', category: 'about', keywords: '诊断日志 导出诊断日志 排查 错误 崩溃 启动 故障 log' }
] as const

export default function SettingsSections({ children, feedback = '' }: { children: ReactNode; feedback?: string }): React.JSX.Element {
  const [activeCategory, setActiveCategory] = useState<string>('general')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = 0
  }, [activeCategory, query])
  const content = new Map(Children.toArray(children).flatMap(child =>
    isValidElement<{ id?: string }>(child) && child.props.id ? [[child.props.id, child] as const] : []))
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const searching = terms.length > 0
  const visibleSections = sections.filter(section => {
    if (!content.has(section.id)) return false
    if (!searching) return section.category === activeCategory
    const categoryLabel = categories.find(item => item.id === section.category)?.label ?? ''
    const text = `${categoryLabel} ${section.keywords}`.toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
  const visibleIds = new Set<string>(visibleSections.map(section => section.id))
  const clearSearch = (): void => { setQuery(''); searchRef.current?.focus() }
  return <>
    <div className="settings-navigation">
      <div className="settings-search-row">
        <div className="settings-search" role="search">
          <Search size={17} aria-hidden="true" />
          <input ref={searchRef} type="search" aria-label="搜索设置" placeholder="搜索设置，例如模型、代理、通知" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') clearSearch() }} />
          {query && <button type="button" aria-label="清除搜索" onClick={clearSearch}><X size={15} /></button>}
        </div>
        <span className="settings-save-feedback" role="status">{feedback}</span>
      </div>
      <nav className="settings-categories" aria-label="设置分类">
        {categories.map(item => <button key={item.id} type="button" aria-current={!searching && activeCategory === item.id ? 'page' : undefined} onClick={() => { setActiveCategory(item.id); setQuery('') }}>{item.label}</button>)}
      </nav>
    </div>
    <ScrollArea className="settings-scroll-area" ref={scrollRef}>
    {searching && <p className="settings-search-count" role="status">找到 {visibleSections.length} 个相关设置分区</p>}
    <div className="settings-category-content">
      {sections.map(section => <div key={section.id} hidden={!visibleIds.has(section.id)}>
        {content.get(section.id)}
      </div>)}
    </div>
    {searching && visibleSections.length === 0 && <div className="settings-empty">
      <Search size={24} aria-hidden="true" />
      <strong>没有找到相关设置</strong>
      <p>试试「模型」「代理」或「通知」，也可以返回分类浏览。</p>
      <button className="secondary-button" type="button" onClick={clearSearch}>清除搜索</button>
    </div>}
    </ScrollArea>
  </>
}
