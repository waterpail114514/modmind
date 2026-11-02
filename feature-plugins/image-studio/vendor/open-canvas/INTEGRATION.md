# ModMind 图像画布适配

来源：用户提供的 `infinite-canvas-v27.07-public-20261030.zip`，快照日期 2026-10-30。`SOURCE_SNAPSHOT.json` 保留参考包原文件指纹，不是适配后文件的校验表。上游 ZeroLu/open-canvas 原始导入提交为 `cf3a906bb8c35bb940d3267497e7f394b8f42582`，MIT 原文及参考包说明保留于 `LICENSE`、`NOTICE.md`。

采用原因：参考包已有完整的 React Flow 手势、撤销历史、节点搜索、素材与版本管理、IndexedDB 事务和冲突处理，复用这些交互比重写画布更符合本次小改范围。保留宿主 React 18 与 React Flow 12；引入 Zustand 5、Radix UI、Sonner 等前端依赖，Tailwind 只在构建时生成限定作用范围的工具类，不引入 Next.js 服务、演示 API 或全局样式重置。

适配范围：

- `transport.ts` 全部图片生成与模型查询调用 ModMind 现有 Image Studio 服务。无前端 API Key 保存、生产 relay 或另一套额度逻辑。
- 图片节点增加 1–10 张、质量、现有 Minecraft 预设。复用后端串行生成，部分失败保留成功结果，错误不会自动重新提交。
- 参考图和结果历史独立；所有批量结果进入同一节点的图片历史。图像尺寸换算遵守 16 倍数与最大像素边界。
- 双击空白画布打开添加节点菜单，关闭 React Flow 默认的双击缩放；普通滚轮和触控板捏合使用 React Flow 原生缩放，以指针位置为中心。左键及中键平移，右键拖动框选（复用 React Flow 节点相交查询），右键单击保留菜单；节点仍用左键移动，编辑区滚轮继续滚动文本。
- “送去处理 / 另存为 / 加入项目”复用现有处理、miniPaint 和保存服务。像素处理及去背景继续使用原有 MCP 工具。
- 凭证与账号额度来自宿主，模型列表失败就近显示可恢复状态。画布按当前项目隔离；旧工作流创建副本，原 IndexedDB 库保持不变。
- React 18 的 Radix 包装器使用 forwardRef；画布样式映射宿主语义主题变量，移除独立配色选择；生成的 CSS 不影响页面外部。
- 画布创建入口聚焦图片、文本输入和便签。不实现整图调度、处理节点、视频或音频生成。运行中的批次等待现有服务返回，可取消尚未开始的队列项；不会宣称取消等待即取消上游计费。

构建：`node scripts/build-feature-plugins.mjs --only=image-studio`，自动生成 `canvas-utilities.css`，许可随便携插件打包。上游变更合并后重跑生成器和图像回归。ModMind 新适配代码遵循仓库的 AGPL 许可证，保留第三方版权声明。

验证：`src/renderer/src/lib/imageCanvasIntegration.test.ts`、原有 Image Studio 服务与实际 MCP 测试，以及 `scripts/image-canvas-smoke.mjs`。浏览器验收使用独立本地夹具和模拟图片，不读取真实凭证或执行付费请求。
