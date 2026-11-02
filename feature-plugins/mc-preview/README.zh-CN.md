# 3D 建筑预览 1.15.1

本次修复解决贡献版在 ModMind 中首次打开失败、资源入口分离、切回页面失效、存档不随项目保存、导入后相机进入建筑内部的问题。保留贡献者的编辑器、文件转换和 Deepslate 渲染核心，由 ModMind 提供项目存储与界面。

## 使用与交付

构建产物为 `feature-plugin-dist/mc-preview.mmfeature`，依赖现有的 `mc-pull` 功能包。通过功能管理安装两个功能包，在模组项目中打开“3D 建筑预览”。点击“方块资源”选择已有的本地游戏实例，然后导入建筑或从空地开始摆放。资源来自所选实例，不自动下载客户端。

- 建筑菜单：新建、切换、复制、重命名、删除，另有旧版浏览器存档恢复入口。
- 编辑：浏览、摆放、删除、拾取、框选、撤销与重做；网格、镜像和分层收进视图菜单。
- 导入：Java 结构 NBT、Schem v2、Litematic。每次导入创建独立建筑，原始文件随建筑保留。
- 导出：Schem v2、Litematic、材料 CSV，或下载未经改动的导入原件。方块朝向等属性和 DataVersion 保留。
- 界面：使用宿主主题与滚动条、宿主重命名及确认弹窗，覆盖 1080×680 窗口；图标与异步资源保持固定空间。
- 导航：右键拖动平移、中键拖动旋转、滚轮缩放；浏览工具支持左键旋转和 Shift+左键平移。拖动紧跟鼠标，松键即停；Esc、失焦及指针取消均结束拖动。

建筑正文写在项目 `structures/<id>.modmind.json`，保存使用修订号检查和临时文件替换，上一版本保存在 `.bak`。删除保留 `.deleted-<时间>.json`，可手工恢复到原文件名。保存冲突不会覆盖工作台更新；页面提供重试、另存为新建筑和导出。旧版浏览器存档需用户明确恢复到当前项目，恢复后保留原数据，不自动归属到任意项目。切页时若落盘失败，当前进程最多暂存四个项目的恢复草稿；关闭整个应用前仍应另存或导出，尚无跨进程草稿日志。

## 复用与选型

| 方案 | 覆盖与兼容性 | 许可、维护与成本 | 结论 |
| --- | --- | --- | --- |
| 已有 [Deepslate](https://github.com/misode/deepslate) 0.27.2 + gl-matrix 3.4.4 | Minecraft 静态方块模型、WebGL、现有编辑器接口；已在打包后的 Electron 中验证 | MIT；沿用交接版本与许可文本，上游可追溯；本地运行，不下载模型库 | 保留渲染核心，修复相机和资源接入 |
| [prismarine-nbt](https://github.com/PrismarineJS/prismarine-nbt) | 成熟的 NBT 读写；不能独立替代文件到建筑、编辑器与渲染工作流 | 上游包声明 MIT、自动化测试，运行依赖 protodef；本地解析可离线，替换仍需转换适配与打包回归 | 本次局部修复继续复用已有读写器，补长度、深度、体积和索引校验，未新增 npm 运行依赖 |
| 现有项目与宿主服务 | FeaturePluginService 校验、项目边界、只读权限、InteractionDialogs、共享主题和滚动条 | 使用仓库已有能力，无新框架 | 界面与 MCP 共享同一存储和格式服务 |

未引入新的游戏资源基线；完整贴图远超 256 KiB 阈值，使用本地实例。目录每页 48 项，名称缓存 1024 项、图标 512 项、最近和收藏各 500 项；后端目录缓存最多四份、30 秒失效，场景按实例文件指纹失效且最多保留一份、120 秒失效。模型图集按建筑所需状态生成，底层仍会在首次建立实例索引时读入 JAR 的模型与贴图字节，大型整合包的首次读取和采集仍可能阻塞，尚未迁移到可取消的后台任务。

Litematic 负尺寸区域按最小角定位，依据 [Litematica 的放置实现](https://github.com/maruohon/litematica/blob/ornithe/1.12.2/src/main/java/litematica/schematic/util/SchematicPlacingUtils.java)。模型贴图沿父到子合并，子模型覆盖父贴图；导入不再自动改写已有方块的连接与朝向。

1.15.1 的导航修复核对了仓库已有 Three.js [OrbitControls](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/controls/OrbitControls.js) 的相机轴、投影尺度与指针捕获流程。当前渲染器使用 Deepslate/gl-matrix，直接引入 OrbitControls 还需维护第二套相机状态，因此继续修复现有视口，不增加依赖。平移轴取实际视图矩阵的行，抓取建筑时在命中表面的视深平面求交，空白处使用相机目标平面。按下和拖动不加入缓动或惯性；导航会从当前画面打断视角切换动画。指针按 ID 和起始键跟踪，补齐移出画布、其他按键释放、捕获丢失、窗口失焦、页面隐藏和卸载的收尾。拖动中暂不处理滚轮，保持抓取平面稳定。

## 工作台 MCP

复用 `items`、`scene`、`import` 和 `export` 工具，增加以下三个任务接口：

- `modmind_mc_preview_documents`：列出当前项目的建筑，或按 id 读取正文、原件和 revision。
- `modmind_mc_preview_save`：创建、保存、重命名、删除；已有对象必须传 `expectedRevision`。
- `modmind_mc_preview_capture`：返回当前已打开建筑的视口 PNG、revision、渲染警告及 `gameVerified:false`。未保存、资源仍在加载、页面未打开或版本过期时拒绝。

MCP 修改后需重新打开建筑以载入；不会自动改动正在编辑的视口。界面和 MCP 共用项目与参数校验，拒绝跨项目输入、越界路径和只读写入。没有把每个视觉控件单独注册为工具。

## 验证与范围

```powershell
node scripts/build-feature-plugins.mjs --only=mc-preview
node --test scripts/mc-preview-core.test.mjs scripts/mc-offline-features.test.mjs
node scripts/mc-preview-ui-smoke.mjs --real-instance=<本机已有的版本实例目录>
npm run typecheck
npm run theme:check
```

UI 脚本在全新的隔离 Electron profile 和项目中安装实际 `.mmfeature`，屏蔽页面 HTTP/HTTPS 请求，使用真实 FeaturePluginService IPC 与 stdio MCP；外围导航为测试夹具，并非完整主应用端到端测试。后端采集和模型读取使用本地 JAR，没有在线资源依赖。测试报告和截图写入 `test-results/mc-preview-ui/<时间>/`。浏览器插件在本机缺少启动脚本，因此改用该桌面测试方式。

已覆盖无资源首次启动、实例采集、分页与中文搜索、首块摆放、拾取删除与撤销、重命名、切页恢复、损坏文件重试、缺失资源警告、导入与实际导出回读、材料清单、项目隔离、保存冲突另存、旧版存档恢复、新建与删除、投影补全及整批撤销重做、MCP 查询/修改/图片回读、1080×680 和深浅主题。真实本地 Minecraft 1.20.1 资源已用于静态建筑画面检查，没有运行游戏内验证。

2026-10-30 的 1.15.0 验收：核心和功能包集成测试 7 项通过，隔离桌面任务检查 13 条通过、页面异常 0 条，类型与主题检查通过。桌面报告为 `test-results/mc-preview-ui/1793370919463/report.json`；实际资源画面为同目录 `real-vanilla-light-1080.png` 与 `real-vanilla-dark-1080.png`。

1.15.1 验收：四组视角/缩放中，鼠标移动 80、40 像素对应画面移动误差小于 0.02 像素，反向拖动回位；移出画布释放、组合按键、指针取消/捕获丢失、失焦和 Esc 均通过（`test-results/mc-preview-ui/1793373383943/report.json`）。动画仍在运行时按右键，确认从按下瞬间的画面值接续且取消旧动画（`1793374173103/report.json`）。包含该动画测试、1080 窗口的建筑表面抓取及原有任务的 15 条完整回归通过、页面异常 0 条（`1793374388105/report.json`）；表面移动实测 65.002、−30.002 像素，建筑修订号不变。核心/集成 7 项、类型与主题检查通过。PNG 对照为最终报告同目录的 `pan-surface-before.png`、`pan-surface-during.png`，真实资源画面仍覆盖 1.20.1。未使用物理鼠标或触控板做人工手感验收。

1.15.1 本地更新包 SHA-256：`f82d3cb58aabc5657ebdcf5982b3d01352581a797da752739c63eff5415c3c20`。

边界：

- 支持静态方块预览；模组自定义渲染器、动态实体和游戏逻辑不保证显示。缺少资源时提示并保留数据。
- Schem v1/v3、MCEdit 数字 ID 格式尚不支持，直接报错；重叠 Litematic 区域产生重复坐标时拒绝导入。
- 方块实体数据（箱子内容、告示牌文字等）、实体和计划刻不写入转换后的文件；导出前要求确认，原件可下载。
- 无法确定 DataVersion 时拒绝导出，不再随意写成 1.20.1。未知注册表默认态仍使用贡献版的近似推导。
- 单建筑最多 25 万个非空气方块、800 万格、单轴 2048、2 万状态；压缩导入文件最多 24 MiB，含原件的项目文档最多 32 MiB。
- 已验证常规小型建筑和原版 1.20.1，未声称完成所有游戏版本、模组组合及最大尺寸性能验收。
