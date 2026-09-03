import type { SidebarViewId } from '../../shared/types'

/**
 * 全应用「页面指南」数据源（产品文案层）。
 *
 * 每个页面包含：
 * - title:   页面在指南中显示的名称
 * - summary: 一句话说清本页是干什么的（显示在标题栏帮助弹层顶部）
 * - steps:   分步教程，每步 = 功能点 + 怎么用
 *
 * 新增页面时：在 SidebarViewId（shared/types.ts）加 id，然后在这里补一条即可，
 * 标题栏「本页指南」按钮和首次进入自动提示会自动覆盖新页面。
 */

export interface PageGuideStep {
  title: string
  detail: string
}

export interface PageGuide {
  title: string
  summary: string
  steps: PageGuideStep[]
}

export const pageGuideSeenKey = (view: string): string => `modmind-guide-seen:v1:${view}`
export const GUIDE_AUTO_DISABLED_KEY = 'modmind-guide-auto-disabled:v1'
export const WELCOME_TOUR_SEEN_KEY = 'modmind-guide-welcome:v1'

const PLUGIN_GUIDE: PageGuide = {
  title: '插件面板',
  summary: '由插件扩展出来的自定义功能面板。',
  steps: [
    { title: '这是什么', detail: '这个页面由已启用的插件提供，具体功能取决于插件本身。' },
    { title: '插件出问题', detail: '如果页面空白或报错，到「管理插件」里检查插件是否启用、版本是否兼容。' }
  ]
}

export const PAGE_GUIDES: Partial<Record<SidebarViewId, PageGuide>> = {
  workspace: {
    title: '工作台',
    summary: 'ModMind 的核心创作入口：用自然语言和 AI 对话，直接生成和修改项目文件。',
    steps: [
      { title: '描述需求', detail: '在底部输入框用一句话描述想要的功能（例如「给钻石剑加一个冰冻效果」），AI 会自动创建或修改文件。' },
      { title: '发送附件', detail: '需要参考时，可粘贴报错日志、贴图或配置文件，AI 会结合上下文回答。' },
      { title: '管理会话', detail: '左侧会话列表可切换、重命名或删除历史对话；不同项目的工作台相互独立。' },
      { title: '执行结果', detail: 'AI 改动文件后会显示变更摘要，可到「代码」「模型」等对应页面查看或继续调整。' }
    ]
  },
  inspiration: {
    title: '灵感台',
    summary: '头脑风暴专用页面：不直接改文件，专门用来和 AI 讨论想法、生成创意方案。',
    steps: [
      { title: '随便聊', detail: '问玩法创意、数值设计、剧情点子——灵感台不会改动项目文件，放心提问。' },
      { title: '带去工作台', detail: '聊出满意方案后，把结论复制到「工作台」让 AI 落地成代码。' },
      { title: '回溯', detail: '对话支持回退重问，历史记录按项目保存。' }
    ]
  },
  'image-studio': {
    title: '图像工坊',
    summary: 'AI 图像生成工坊：为 mod 生成材质、logo、宣传图等像素或插画素材。',
    steps: [
      { title: '写提示词', detail: '描述想要的画面，像素风材质可加「16x16 pixel art」「Minecraft style」等关键词。' },
      { title: '选择风格', detail: '在设置里选择模型与风格参数，贴近材质需求。' },
      { title: '保存使用', detail: '生成满意后下载保存，再导入资源包或模型工作台使用。' },
      { title: '连接设置', detail: '右上角设置可配置图像服务的账号与参数。' }
    ]
  },
  blockbench: {
    title: '模型',
    summary: '内置 Blockbench 建模器，配合 AI 一键生成模型候选，再手动微调并应用。',
    steps: [
      { title: '手动建模', detail: '中间画布是完整 Blockbench：模型 / 贴图 / 动画三种模式随时切换，操作和原版一致。' },
      { title: 'AI 建模', detail: '点工具栏「AI 建模」打开候选面板，描述需求后 AI 生成的模型以独立候选呈现，确认无误再应用。' },
      { title: '面板摆放', detail: '候选面板可「停靠」（与画布并排）或「浮出」（盖在画布旁），面板边缘可拖拽调宽。' },
      { title: '历史回退', detail: '「历史」面板保留最近 20 个检查点，随时回到之前的模型状态。' }
    ]
  },
  code: {
    title: '代码编辑器',
    summary: '内置 Monaco 编辑器：浏览和修改项目源码，支持语法高亮与 AI 辅助。',
    steps: [
      { title: '找文件', detail: '左侧文件树按目录展开，点文件在右侧打开编辑。' },
      { title: '编辑', detail: '支持多标签页、撤销/重做、搜索替换，改动实时保存到项目。' },
      { title: '配合 AI', detail: '建议在「工作台」让 AI 批量生成代码，再到这里做精细微调。' }
    ]
  },
  relationships: {
    title: '前置与联动',
    summary: '管理当前 mod 依赖哪些前置模组，以及与其它模组的联动关系。',
    steps: [
      { title: '查看依赖', detail: '列表展示当前项目声明的前置模组及其版本范围。' },
      { title: '增删依赖', detail: '按需添加或移除前置；改动会影响构建时的依赖解析。' },
      { title: '联动检查', detail: '与其它 mod 的注册冲突、事件联动问题会在此提示。' }
    ]
  },
  decompile: {
    title: '反编译',
    summary: '把 jar 包反编译成可读源码，用来学习其它 mod 的实现或排查兼容问题。',
    steps: [
      { title: '选 jar', detail: '选择或拖入要分析的 jar 文件（可从「模组列表」「依赖」页跳转过来）。' },
      { title: '等解析', detail: '反编译需要一些时间，进度会实时显示。' },
      { title: '读源码', detail: '完成后按类名浏览源码，可搜索方法与字段。' }
    ]
  },
  minecraft: {
    title: '游戏测试',
    summary: '从 ModMind 里直接启动 Minecraft 测试当前项目，不必切出去手动开游戏。',
    steps: [
      { title: '启动游戏', detail: '选择游戏版本与启动配置，点击启动；控制台输出会实时滚动。' },
      { title: '看日志', detail: '崩溃或报错信息可一键复制，贴到「工作台」让 AI 帮你分析。' },
      { title: '联动修复', detail: '检测到依赖问题时，可从这里跳到「前置与联动」修复。' }
    ]
  },
  build: {
    title: '构建与导出',
    summary: '把源码构建成可安装的 mod jar，并做发布前的检查。',
    steps: [
      { title: '构建', detail: '点击构建，Gradle 会编译并打包 jar，输出与错误实时显示。' },
      { title: '查产物', detail: '构建成功后可直接打开产物目录。' },
      { title: '发布前检查', detail: '构建失败时优先看第一条报错，可复制给工作台 AI 分析。' }
    ]
  },
  production: {
    title: '发布',
    summary: '把构建好的 mod 发布到平台（如 Gitee / Modrinth 等），管理版本发布流程。',
    steps: [
      { title: '填版本信息', detail: '填写版本号、更新日志、兼容的 MC 版本。' },
      { title: '绑定账号', detail: '首次发布需要配置平台的访问凭据，按界面引导完成授权。' },
      { title: '上传', detail: '确认无误后发布，失败时按提示重试。' }
    ]
  },
  snapshots: {
    title: '版本记录',
    summary: '项目的「存档点」：重要改动前拍快照，改坏了随时回滚。',
    steps: [
      { title: '拍快照', detail: '在大改动前手动创建快照，保存当前整个项目状态。' },
      { title: '对比与回滚', detail: '选择任意快照查看差异或一键还原。' },
      { title: '自动快照', detail: 'AI 批量修改文件前后也会自动记录，防止丢失。' }
    ]
  },
  mappings: {
    title: 'Mappings',
    summary: '查看与反混淆 Minecraft 字节码的映射表，用于理解混淆后的类名与方法名。',
    steps: [
      { title: '搜索类', detail: '输入类名或方法名搜索映射结果。' },
      { title: '看细节', detail: '点开结果查看字段、方法签名与所属版本。' },
      { title: '配合反编译', detail: '与「反编译」页配合使用效果最佳。' }
    ]
  },
  settings: {
    title: '设置',
    summary: '配置 ModMind 的外观、语言、AI 服务与账号。',
    steps: [
      { title: '外观', detail: '深色模式、界面密度等在此调整。' },
      { title: 'AI 服务', detail: '配置 AI 模型的连接与密钥；连接账号后可直接使用内置额度。' },
      { title: '项目默认', detail: '设置新建项目的默认加载器、Java 版本等。' }
    ]
  },
  plugins: {
    title: '管理插件',
    summary: 'ModMind 的插件中心：安装、启用、禁用社区插件，扩展新功能。',
    steps: [
      { title: '浏览插件', detail: '列表展示可用插件及其说明、版本与权限。' },
      { title: '启停', detail: '启用后面板类插件会出现在侧栏「插件」分组，悬浮窗类插件直接生效。' },
      { title: '安全提示', detail: '只安装可信来源的插件；异常插件会被自动禁用并标记错误。' }
    ]
  },
  'modpack-manifest': {
    title: '文件清单',
    summary: '查看与编辑整合包的总体清单（manifest）：包名、版本、模组清单与文件结构。',
    steps: [
      { title: '看结构', detail: '树形展示整合包内全部文件与目录。' },
      { title: '编辑元信息', detail: '修改包名、作者、版本号等基础信息。' }
    ]
  },
  'modpack-mod-list': {
    title: '模组列表',
    summary: '整合包内所有模组的管理列表：启停、查看详情、跳转反编译。',
    steps: [
      { title: '浏览模组', detail: '列出包内每个 mod 的名称、版本与文件大小。' },
      { title: '进入项目', detail: '点开某个模组可深入查看其文件。' },
      { title: '分析', detail: '支持对任意模组发起反编译或 AI 分析。' }
    ]
  },
  'third-party-mods': {
    title: '模组下载',
    summary: '从在线仓库搜索并下载第三方 mod，直接装进整合包。',
    steps: [
      { title: '搜索', detail: '按名称、类别、MC 版本筛选搜索结果。' },
      { title: '下载安装', detail: '选择兼容版本一键下载并放入整合包。' },
      { title: '检查冲突', detail: '下载后注意依赖提示，缺前置会在此标出。' }
    ]
  },
  'modpack-config': {
    title: '配置与默认项',
    summary: '集中管理整合包内各 mod 的配置文件与默认设置。',
    steps: [
      { title: '选配置', detail: '列出包内可编辑的配置文件，点击进入编辑。' },
      { title: '设默认', detail: '为玩家首次进入设置默认选项（键位、画质等）。' }
    ]
  },
  'modpack-scripts': {
    title: '脚本与 KubeJS',
    summary: '通过 KubeJS 脚本定制合成表、事件与玩法逻辑，无需写 Java。',
    steps: [
      { title: '脚本目录', detail: '左侧列出 server_scripts / startup_scripts 等脚本目录。' },
      { title: '编写', detail: '用 JS 语法编写或让工作台 AI 生成脚本，保存后进游戏生效。' }
    ]
  },
  'modpack-datapacks': {
    title: '数据包',
    summary: '管理整合包内的数据包：进度、配方、战利品表等原版数据扩展。',
    steps: [
      { title: '浏览', detail: '查看已装数据包列表与内部结构。' },
      { title: '编辑', detail: '直接编辑配方、进度等 JSON 数据文件。' }
    ]
  },
  'ftb-quests': {
    title: 'FTB 任务书',
    summary: '可视化编辑 FTB 任务：章节、任务链、奖励与依赖关系，全部拖拽完成。',
    steps: [
      { title: '建章节', detail: '先创建章节，再把任务拖进章节。' },
      { title: '连任务', detail: '用连线定义任务先后依赖，玩家需按顺序完成。' },
      { title: '设奖励', detail: '为任务配置物品奖励或命令奖励。' }
    ]
  },
  patchouli: {
    title: 'Patchouli 指南书',
    summary: '编写游戏内的指南书（Patchouli 格式），给玩家做 mod 说明文档。',
    steps: [
      { title: '建分类', detail: '先建书籍分类，再往里加条目页面。' },
      { title: '写条目', detail: '用文本 + 模板编写条目，保存后游戏内即可查看。' }
    ]
  },
  'modpack-resourcepacks': {
    title: '资源包',
    summary: '管理整合包内的资源包：材质、音效、模型等客户端资源。',
    steps: [
      { title: '浏览', detail: '列出包内资源包及其内容结构。' },
      { title: '替换材质', detail: '可直接替换贴图文件，或配合「图像工坊」生成新材质。' }
    ]
  },
  'modpack-shaders': {
    title: '光影包',
    summary: '管理整合包内置的光影包。',
    steps: [
      { title: '浏览', detail: '查看已内置的光影包列表。' },
      { title: '增删', detail: '添加或移除光影包文件；玩家在游戏内自行选择开启。' }
    ]
  },
  'modpack-ui': {
    title: '界面资源',
    summary: '定制整合包的界面元素：HUD、菜单、图标等 UI 资源。',
    steps: [
      { title: '浏览', detail: '查看可定制的界面资源文件。' },
      { title: '替换', detail: '替换对应贴图即可改变游戏内界面外观。' }
    ]
  },
  'modpack-worlds': {
    title: '存档与世界',
    summary: '管理整合包内置的存档与自定义世界。',
    steps: [
      { title: '浏览存档', detail: '列出内置存档及其大小与修改时间。' },
      { title: '导入导出', detail: '可把本地存档打包进整合包，随包分发。' }
    ]
  },
  'modpack-client': {
    title: '玩家预设',
    summary: '为玩家预设客户端体验：默认键位、选项、资源包开关顺序等。',
    steps: [
      { title: '选预设项', detail: '选择要预设的配置类别。' },
      { title: '编辑值', detail: '修改默认值，玩家首次启动即按预设生效。' }
    ]
  },
  'modpack-server-content': {
    title: '服务端配置',
    summary: '管理整合包服务端专属的配置与文件。',
    steps: [
      { title: '浏览', detail: '查看 server 目录下的配置文件。' },
      { title: '编辑', detail: '修改服务端参数（视野、难度、白名单等）。' }
    ]
  },
  'modpack-files': {
    title: '文件工作台',
    summary: '整合包通用文件管理器：浏览、编辑、上传任意文件。',
    steps: [
      { title: '浏览', detail: '树形列出整合包全部文件。' },
      { title: '编辑', detail: '文本文件可直接编辑保存，二进制文件只读。' }
    ]
  },
  'modpack-migration': {
    title: '版本迁移',
    summary: '把整合包从一个 MC 版本迁移到另一个版本，自动处理兼容问题。',
    steps: [
      { title: '选目标版本', detail: '选择要迁移到的 MC 版本与加载器版本。' },
      { title: '执行迁移', detail: '工具会批量更新模组版本与配置，冲突项会逐条提示。' },
      { title: '验证', detail: '迁移完成后用「游戏测试」验证可玩性。' }
    ]
  },
  'modpack-automation': {
    title: '依赖与优化',
    summary: '自动整理整合包依赖、清理冗余并做性能优化建议。',
    steps: [
      { title: '一键体检', detail: '扫描依赖缺失、重复与冲突。' },
      { title: '应用优化', detail: '按建议启用优化项，改善游戏性能。' }
    ]
  },
  'modpack-server': {
    title: '本机服务端',
    summary: '在本机一键搭建并启动整合包服务端，联机测试用。',
    steps: [
      { title: '生成服务端', detail: '按引导生成服务端目录并安装依赖。' },
      { title: '启动', detail: '启动后控制台实时输出，可在此同意 EULA、管理玩家。' }
    ]
  },
  'modpack-content': {
    title: '任务与手册',
    summary: '任务书（FTB Quests）与指南书（Patchouli）的聚合入口。',
    steps: [
      { title: '选模块', detail: '在页面内切换任务书或指南书编辑器。' },
      { title: '深入编辑', detail: '也可直接从侧栏进入「FTB 任务书」或「Patchouli 指南书」。' }
    ]
  }
}

export function getGuideForView(view: SidebarViewId): PageGuide {
  if (view.startsWith('plugin:')) return PLUGIN_GUIDE
  return PAGE_GUIDES[view] ?? {
    title: '本页指南',
    summary: '这一页的功能介绍尚未编写。',
    steps: [{ title: '需要帮助？', detail: '可以在「工作台」直接向 AI 提问，或到「设置」查看文档。' }]
  }
}

export const WELCOME_TOUR_STEPS: PageGuideStep[] = [
  { title: '第 1 步 · 打开项目', detail: '启动后在项目启动器里新建或打开一个 mod / 整合包项目，所有创作都在项目内进行。' },
  { title: '第 2 步 · 对话式创作', detail: '进入「工作台」，用一句话告诉 AI 你想要的功能（如「做一把能发射火球的剑」），文件会自动生成。' },
  { title: '第 3 步 · 打磨素材', detail: '用「模型」（Blockbench）做建模、「图像工坊」生成贴图、「代码」微调源码。' },
  { title: '第 4 步 · 测试与发布', detail: '「游戏测试」直接启动 MC 验证效果，满意后「构建与导出」打包 jar 并发布。' }
]

/**
 * 互动引导（聚光高亮）：target 为 CSS 选择器，指向需要高亮的真实界面元素。
 * 镂空区域外的界面会被遮罩挡住，引导用户真正点击目标元素后按「下一步」继续。
 * 新增页面引导：先给目标元素加 data-tour="xxx"，再在这里补一条 { target: '[data-tour="xxx"]', ... }。
 */
export interface TourStepDef {
  target: string
  title: string
  detail: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

/** 全局快速上手（欢迎引导里可一键启动）：认识外壳的 4 个关键位置。 */
export const SHELL_TOUR_STEPS: TourStepDef[] = [
  { target: '.sidebar-nav', title: '第 1 步 · 功能导航', detail: '左侧是 ModMind 的全部功能页面，点任意一项即可切换。建议先去「工作台」。', placement: 'right' },
  { target: '[data-tour="titlebar-mode"]', title: '第 2 步 · 专业模式', detail: '默认「简单模式」只显示常用功能；打开开关后显示全部开发工具与设置。', placement: 'bottom' },
  { target: '[data-tour="titlebar-help"]', title: '第 3 步 · 随时求助', detail: '每个页面的问号按钮都有使用指南，还能重新启动这份互动引导。', placement: 'bottom' },
  { target: '[data-tour="titlebar-account"]', title: '第 4 步 · 账号与额度', detail: '在这里连接 ModMind 账号、查看 AI 额度余额。', placement: 'bottom' }
]

/** 各页面的互动引导步骤（有真实可高亮元素的页面才配置）。 */
export const PAGE_TOURS: Partial<Record<SidebarViewId, TourStepDef[]>> = {
  workspace: [
    { target: '.agent-workbench .agent-composer textarea', title: '第 1 步 · 说出你的想法', detail: '在这里用一句话描述想要的功能，例如「给钻石剑加冰冻效果」。现在就可以直接输入。', placement: 'top' },
    { target: '.agent-workbench .agent-send-button', title: '第 2 步 · 发送给 AI', detail: '写好后点这个发送按钮（或按 Enter），AI 会自动创建和修改项目文件。', placement: 'top' },
    { target: '.agent-conversation-picker', title: '第 3 步 · 管理对话', detail: '点这里切换、新建或删除对话；不同对话共享同一个项目文件。', placement: 'bottom' },
    { target: '[data-tour="titlebar-help"]', title: '第 4 步 · 随时回顾', detail: '点标题栏的问号可以重看本页指南，或再次启动这份互动引导。', placement: 'bottom' }
  ],
  blockbench: [
    { target: '[data-tour="bb-intent-toggle"]', title: '第 1 步 · 打开 AI 建模', detail: '点击这个按钮打开 AI 建模面板，用自然语言让 AI 生成模型候选。现在就试试点击它。', placement: 'bottom' },
    { target: '[data-tour="bb-intent-pin"]', title: '第 2 步 · 停靠或浮出', detail: '面板右上角的图钉可在「停靠」（与画布并排）和「浮出」（盖在画布旁）之间切换。', placement: 'left' },
    { target: '[data-tour="bb-history-toggle"]', title: '第 3 步 · 模型历史', detail: '点这个按钮打开历史面板，最近 20 个检查点可随时回退。', placement: 'bottom' },
    { target: '[data-tour="bb-intent-resize"]', title: '第 4 步 · 调整面板宽度', detail: '拖住面板左缘可自由调宽，布局更顺手。引导完成，开始创作吧！', placement: 'left' }
  ]
}
