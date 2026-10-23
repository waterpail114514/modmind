# ModMind 接入记录

源码来自用户提供的 `mc-offline-tool-交接包-2026-10-15.zip`；原始文件校验清单见 `UPSTREAM.json`。归档没有交接文档所称的根 `manifest.json`，因此该清单由实际解压文件生成。原包和原始归档未改动。

构建入口为 `feature-plugins/mc-pull`（1.14.2）与 `feature-plugins/mc-preview`（1.14.13），使用仓库现有 esbuild/功能包打包脚本：

```powershell
node scripts/build-feature-plugins.mjs --only=mc-pull
node scripts/build-feature-plugins.mjs --only=mc-preview
node --test scripts/mc-offline-features.test.mjs
```

产物位于 `feature-plugin-dist/mc-pull.mmfeature` 和 `mc-preview.mmfeature`。在同一个 ModMind 项目中安装、启用两包后，采集页选择本地实例目录，基础数据写入 `.modmind/mc-capture/packs/`；预览读取当前项目 `active.txt` 选择的包及其来源实例。开发者工作台可分别导入两包；独立测试项目不会自动使用用户正常项目中的采集数据。

保留交接源码中的格式解析、编辑器、PNG/NBT、资源打包和第三方渲染核心。Deepslate 版本按交接声明为 0.27.2，gl-matrix 为 3.4.4；完整 MIT 文本随两包资源分发。已核对上游 [Deepslate](https://github.com/misode/deepslate)、[gl-matrix](https://github.com/toji/gl-matrix)，沿用已有实现避免重写领域逻辑，没有新增 npm 运行依赖或下载游戏资源。

接入差异：

- 页面通过 ModMind 原有注册契约、React 和 preload API 加载，后端适配现有动作服务与工作台 MCP。
- 项目路径取调用上下文；拒绝跨项目输入和自定义输出路径；采集包路径检查链接与越界，实例包 key 加路径哈希，避免同名实例混用。
- 基础采集从实例 blockstates 确认方块，并支持英文名称回退、中文优先。没有注册表时仍能使用本地静态资源；动态生成内容不作完整性承诺。
- 场景使用当前采集包的来源实例；缓存有容量、失效时间与文件变更检测。物品查询可分页，图标按需读取。缺少采集数据时给出采集入口提示。
- 去掉采集页的重复标题说明，增加原生目录选择操作；未提供的探针构建保持不可用状态。

已验证：自建最小客户端 JAR 的真实采集、中文名称与方块标识、分页和缓存更新、图标和模型图集、Schem/Litematic 往返、项目及只读边界，以及真实 stdio MCP 的工具发现、查询和 ZIP 导出。夹具不是 Minecraft 游戏数据。交接包未包含游戏数据、探针 JAR 或探针源码；真实游戏内采集、启动与跨游戏版本覆盖未验证。
