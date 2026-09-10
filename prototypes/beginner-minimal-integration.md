# 简约工作台接入说明

更新：2026-09-10。简约模式已在主应用启用。独立 HTML 仍是离线效果页，不连接账号或执行真实制作。

## 页面与模式

- App 的现有 AgentWorkbench 根据 uiMode 选择 minimal / full 外观，共用项目、会话、输入、附件和运行状态。
- 开场大字复用 ChatWelcome；输入框下方的三个推荐项复用 ChatRecommendations 与 createChatStarters('workbench')。点击只填入草稿，换一组不发送消息。
- 小白模式隐藏原侧栏，通过顶部作品菜单切换项目。专业模式开关恢复原侧栏并进入工作台，不取消任务、不重建会话。
- 模型列表来自账号的 device.listModels。模型与思考强度继续使用 App.saveBeginnerAiPreference；设置保存中和任务运行中锁定控件，保存期间禁止发送。
- 无项目时首次发送自动在系统文档目录下的 `modmindproject/project-<唯一标识>` 创建仅对话项目，等待会话存储就绪后自动发送第一条消息，不再弹出创建窗口。
- 空壳只创建项目清单和 `.modmind` 数据目录，版本、平台、类型均在后续对话中明确记录。点击“开始制作”时，缺少信息就继续只读问答；信息完整则校验兼容目录并在原路径生成真实模板，保留会话、原生会话作用域和已有文件。
- 模板先在旁边的临时目录生成，使用排他复制防止覆盖已有文件，最后提交项目清单。模板失败保留空壳，可重试。显示中不把内部占位平台当作用户已选平台。
- 桌面空白页围绕输入框居中，标题在上、推荐在下；小屏和低矮窗口保留自适应间距。

## 两阶段链路

小白模式普通发送：

    AgentWorkbench.onStart
      -> App.captureIdea
      -> 保存工作台用户消息和会话索引
      -> ai.createCode(..., 'quota', 'beginner-unlimited', {
           surface: 'workspace',
           workbenchPhase: 'discussion',
           inspirationQuestion,
           projectPath, conversationId, generation, sessionScope, turnId
         })
      -> main.runExternalCodingAgent
      -> usesInspirationWorkflow
      -> inspirationQuotaConfig / inspirationReasoningEffort
      -> 灵感台只读运行器与直接回答

问答仍归属 workspace，以便共用单任务锁、停止、输出事件和工作台历史；workbenchPhase 只切换运行策略。只读策略禁止写入工具、依赖安装、构建和测试。项目版本和加载器进入提问上下文，避免重复追问。

该阶段不调用 project.captureIdea，不创建工程恢复快照，不自动恢复旧工程任务。回答完成后显示“开始制作”；有未发送草稿或附件时先处理当前输入，防止交接丢失草稿。

点击“开始制作”：

    App.captureIdea('engineering')
      -> 完整可见对话与附件上下文交接
      -> project.captureIdea
      -> ai.createCode(..., 'quota', 'beginner-unlimited', {
           surface: 'workspace',
           projectPath, conversationId, generation, sessionScope, turnId
         })
      -> 原工作台工程运行器、构建、验证与恢复

工程阶段共用专业模式“使用额度”的完整链路，读取用户选定模型和思考强度。不会把讨论内容当作已经完成的修改。缺少工程必要信息时仍允许追问。

UI 热切换与引擎切换是两件事。快速问答运行时可切换界面；切换 Codex / Claude / quota 引擎需等回答结束或先停止，前后端都有保护。专业模式直接发送仍按原工程规则。

## 存储与实际接口

- 两阶段共享 conversationId 和 sessionScope，各自具有独立 turnId。
- 输出复用 ai.onOutput / ai.onProgress 和工作台时间线归约器。
- 取消共用 cancelAi / ai.cancelCode，工程恢复共用 resumeInterruptedAi。
- 模型偏好通过 device.saveAiPreferences 保存，最终推理档位由主进程 beginnerReasoningEffort 映射。
- 文件附件、游戏测试、导出继续复用原组件和回调；HTML 的 PNG、JSON 和计时器不是生产实现。

## 验证

- npm run typecheck：通过。
- npx electron-vite build：通过，有既有的 chunk 体积和混合导入提示。
- 工作流策略、模型偏好、会话策略及原工作台/灵感推荐项测试：20 项通过。
- test-results/beginner-minimal/react-check.mjs：验证真实组件的推荐项位置、草稿保留、热切换、偏好保存屏障与手机布局。
- test-results/beginner-minimal/app-check.cjs：隔离 Electron 配置和临时项目中验证主应用问答到工程交接、同一会话、问答不写 idea.md、工程写入交接内容与历史重新加载。
- test-results/beginner-minimal/draft-app-check.cjs：验证首次自动创建、自动发送一次、无需弹窗、缺信息继续问答、真实模板原路径升级与历史重新加载。测试重定向了 Documents 到隔离目录，未写用户的真实文档目录。
- test-results/beginner-minimal/check.cjs：独立 HTML 的交互、导出与响应式验证。

Electron 集成测试使用 AI IPC 替身，未发起付费请求、未运行 Minecraft，不能替代真实账号的生产验收。正在运行的旧主进程需要重启才能加载新增的两阶段策略。
