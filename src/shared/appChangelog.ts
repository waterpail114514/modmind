export interface AppChangelogRelease {
  version: string
  sections: { title: string; items: string[] }[]
}

export interface AppChangelogSnapshot {
  currentVersion: string
  automatic: boolean
  releases: AppChangelogRelease[]
}

// Keep newest first. Future entries are drafts, hidden until that app version ships.
// Keep an entry matching package.json when preparing each release.
// These notes ship with the app so the first launch works fully offline.
export const APP_CHANGELOG: AppChangelogRelease[] = [
  {
    version: '1.4.19',
    sections: [
      { title: '修复', items: [
        '修复接管项目时将其他依赖版本误识别为 Minecraft 版本的问题；多版本工程需选择目标版本，也可手动填写，支持 26.x 版本。',
        '修复 Minecraft 与 Java Runtime 下载未使用配置代理或系统代理的问题。',
        '修复 Java Runtime 损坏缓存无法恢复的问题，准备实例时校验并修复文件，失败后清理未完成下载并显示具体原因。',
        '修复整合包构建并同步完成后仍返回目录读取错误的问题，现返回同步清单，并明确区分构建失败与产物记录失败。',
        '修复已取消的测试实例准备仍可能继续执行的问题。',
        '修复外部 Agent 提前退出时，写入任务内容引发未处理错误的问题。'
      ] }
    ]
  },
  {
    version: '1.4.18',
    sections: [
      { title: '修复', items: [
        '修复使用 Connector 的整合包导入兼容性判断，识别兼容桥并保留原包中的相关模组，避免错误拦截和误导提示。'
      ] }
    ]
  },
  {
    version: '1.4.17',
    sections: [
      { title: '改进', items: [
        '新增「更长上下文」设置，默认将自动整理阈值控制在 256K 以内；需要时可启用更长上下文，并保留手动设置。',
        '完善 Gradle 构建和服务端验证的工具链补齐、下载源切换与取消处理，并提供更准确的 JDK 缺失提示。'
      ] },
      { title: '修复', items: [
        '修复部分模型线路无法正确接收工具返回图片的问题，并根据当前线路的能力信息和验证结果更新识图状态。',
        '修复余额不足或缓存中的冻结状态阻止使用上游免费模型线路的问题，实际可用性以服务端响应为准。',
        '修复会话重连后重复显示工具准备、会话恢复和项目分析状态的问题。',
        '修复 JDK 或编译失败被误判为 Gradle 下载失败的问题，避免反复切换下载源和错误的下载状态。',
        '修复 Forge / NeoForge 服务端验证的运行目录处理，以及进程提前退出仍可能被判定为稳定运行的问题。',
        '修复包含内嵌模组描述的 NeoForge Connector 等引导组件被误判为无效 Mod 的问题。',
        '补齐 Windows 安装包内的自动更新配置，并校验更新清单、安装包与内置 Gradle Wrapper，修复旧包缺少更新配置导致检查更新失败的问题。'
      ] }
    ]
  },
  {
    version: '1.4.16',
    sections: [
      { title: '修复', items: [
        '修复 Windows 版创建 Mod 项目时内置 Gradle Wrapper 校验失败的问题。'
      ] }
    ]
  },
  {
    version: '1.4.15',
    sections: [
      { title: '修复', items: [
        '修复 AI 回复达到输出上限后任务意外结束的问题，现在会保留进度并自动继续。',
        '修复 AI 玩家测试未复用已有缓存，导致反复下载 Minecraft 和安装加载器的问题。'
      ] }
    ]
  },
  {
    version: '1.4.14',
    sections: [
      { title: '新增', items: [
        '支持使用本机 Codex 的登录与配置，自动识别已安装的 CLI、当前模型和可用模型列表。',
        '版本记录新增备份占用统计，展示文件累计大小与磁盘去重估算；占用偏大时在页面和侧栏提醒。',
        '内置离线更新日志，升级后首次打开自动展示，全新安装不弹出；也可在设置中查看历史版本。'
      ] },
      { title: '改进', items: [
        '新建项目或首次生成工程时，根据项目名自动为默认命名空间生成英文标识；保留手动命名，AI 不可用时使用原值。',
        '统一 ModMind 与本机 Codex 的模型设置入口，可分别调整模型、思考强度、上下文上限和自动整理阈值。',
        '导入项目时显示解压进度和识别阶段，失败后可直接重新选择；选择已有 ModMind 项目文件夹时直接打开。',
        '移除本地项目压缩包导入的固定文件数量、单文件大小和总解压体积限制。',
        '加强 AI 项目工具的连接检查和中断恢复；模型报告工具不可用且未执行操作时，不再将任务标记为完成。'
      ] },
      { title: '修复', items: [
        '修复删除项目后在原位置重建时继承旧项目知识的问题，并清理新建项目路径上的遗留知识。',
        '修复旧版 Forge 安装版本号重复拼接的问题，并在部分下载错误或停滞时切换下载源重试。',
        '快照排除构建、运行日志和 Gradle 测试缓存，并清理旧快照中可确认的 Gradle 测试缓存，减少无效备份占用。',
        '下载悬浮窗优先显示正在进行的任务与进度，避免历史失败任务遮盖当前下载状态。',
        '修正 Codex 默认思考强度选项，并为不受支持的档位和已禁用的 API Key 提供明确提示，避免无效重试。'
      ] },
      { title: '调整', items: [
        '移除 Claude Code 引擎入口及相关配置，工作台保留 ModMind 和本机 Codex。'
      ] }
    ]
  },
  {
    version: '1.4.13',
    sections: [
      { title: '新增', items: ['升级后首次打开时显示更新日志，也可在设置中随时查看。'] }
    ]
  },
  {
    version: '1.4.12',
    sections: [
      { title: '改进', items: [
        '改进模型上下文、自动整理和思考强度设置。',
        '优化额度模型偏好、Agent 工具准备状态和工作台配置。',
        '完善扩展准备与设置界面。'
      ] }
    ]
  }
]
