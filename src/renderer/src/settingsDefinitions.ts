export const settingsCategories = [
  { id: 'general', label: '通用', description: '调整外观、通知与日常使用偏好。' },
  { id: 'ai', label: 'AI 与图像', description: '选择适合你的模型，管理图像服务与执行审批。' },
  { id: 'development', label: '开发与构建', description: '管理 Java 环境、本地构建与远程构建。' },
  { id: 'integrations', label: '集成', description: '连接外部 Agent、MCP 客户端与网络代理。' },
  { id: 'about', label: '关于', description: '检查更新、重装应用，或查看许可证与诊断日志。' }
] as const

export const settingsSections = [
  { id: 'settings-appearance', category: 'general', keywords: '外观 主题 配色 颜色 ModMind 默认 中性 暖砂 青绿 石墨 深色模式 暗色模式 浅色模式 自定义 背景 图片 视频 本地 手动 调色 强调色 可见度 模糊 壁纸 dark theme wallpaper' },
  { id: 'settings-sidebar-order', category: 'general', keywords: '外观 侧边栏编辑 侧边栏顺序 侧栏排序 显示 隐藏 入口 分类 大类 分组 创建 新建 删除 重命名 名称 移动 撤销 重置侧栏 恢复默认布局 sidebar' },
  { id: 'settings-notifications', category: 'general', keywords: '通知 关闭窗口 系统托盘 最小化 后台 任务完成通知 notification' },
  { id: 'settings-ai', category: 'ai', keywords: 'AI 模型 思考强度 推理 快速模式 Fast 模式 model 上下文 窗口 上限 手动 自动 压缩 阈值 context token compaction 512K' },
  { id: 'settings-image', category: 'ai', keywords: '图片模型 图像服务 自定义图像 API Key Base URL 模型 额度 图像工坊 image' },
  { id: 'settings-approval', category: 'ai', keywords: '执行审批 审批模式 权限 沙箱 自动审批 手动审批 YOLO Codex Claude Code 工作台' },
  { id: 'settings-java', category: 'development', keywords: 'Java JDK 游戏运行时 Minecraft Gradle 构建 JDK 编译 内置工具 JAVA_HOME' },
  { id: 'settings-build', category: 'development', keywords: '本地构建 构建工具 Gradle Wrapper 编译' },
  { id: 'settings-remote', category: 'development', keywords: '远程构建 云 Gitee Go 仓库地址 构建分支 Token 流水线' },
  { id: 'settings-release', category: 'integrations', keywords: '发布平台 平台绑定 Modrinth CurseForge GitHub Token 令牌 项目 ID 仓库 release publish' },
  { id: 'settings-agents', category: 'integrations', keywords: '外部 Agent Codex Claude Code 配置 安装 API Key Base URL 模型 上下文 窗口 上限 压缩 阈值 context token compaction' },
  { id: 'settings-mcp', category: 'integrations', keywords: 'MCP 接入 外部 MCP 桥接 本机客户端 配置' },
  { id: 'settings-network', category: 'integrations', keywords: '网络 下载代理 HTTP 代理地址 网络代理 proxy' },
  { id: 'settings-legal', category: 'about', keywords: '许可证 版权 版本 源码 开源 AGPL MIT license 第三方 声明' },
  { id: 'settings-diagnostics', category: 'about', keywords: '诊断日志 导出诊断日志 排查 错误 崩溃 启动 故障 log' },
  { id: 'settings-updates', category: 'about', keywords: '版本 更新 检查更新 扫描更新 一键更新 最新版 重装 重新安装 清理 缓存 AppData update reinstall' },
  { id: 'settings-authors', category: 'about', keywords: '关于作者 制作人 客户端 网页 以太工作室 水桶 柠檬 社区贡献者 佚名即无名 SQ0 优化素材贡献者 理惠 C.all' }
] as const

export function findSettingsSections(availableIds: ReadonlySet<string>, activeCategory: string, query: string): {
  searching: boolean
  visibleSections: Array<(typeof settingsSections)[number]>
} {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const searching = terms.length > 0
  const visibleSections = settingsSections.filter(section => {
    if (!availableIds.has(section.id)) return false
    if (!searching) return section.category === activeCategory
    const categoryLabel = settingsCategories.find(item => item.id === section.category)?.label ?? ''
    const text = `${categoryLabel} ${section.keywords}`.toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
  return { searching, visibleSections }
}
