# 游戏测试、国内下载链路修复与实测（2026-10-28）

用户在限制复核后授权“修”，随后要求继续核对两个版本、随机真实下载模组/整合包并说明验证内容。本轮修改 1.4 与 main 工作树，沿用 AUD-103 / AUD-097；没有改模型线路或积分结算，没有发布安装包。原审计的“尚未修复”是当时状态，本轮结果以本文及同名证据目录为准。

## 已实施

| 问题 | 当前处理 |
| --- | --- |
| 测试启动等待构建/下载后才返回，容易撞到 300 秒响应头等待；失败后又 start | 原生 Mod、插件/整合包玩家测试在准备前登记 sessionId，state 不排在长准备队列后；stop 可取消准备。test_matrix / test_minecraft / test_rendered 复用既有托管任务，短调用返回 taskId，单次查询最多等待 20 秒。同一在途输入复用任务；本轮结束前检查未完成/未读取任务并回收本轮资源 |
| 慢速文件始终在传输也被 120 秒/5 分钟/15 分钟切断 | 通用下载默认改为连续 180 秒无响应数据才判停滞，响应头 60 秒；仅显式 timeoutMs 才有整次预算。Wrapper、JDK、HeadlessMC 启动器、MRPack/CurseForge/内容文件、依赖中心迁移到此策略；移除依赖中心额外的 120 秒 signal |
| 失败从头下载 | 有预期哈希的下载支持持久 partial、Range、If-Range / ETag、200 覆盖重下及完整哈希验证后原子替换；完成文件校验后复用。复用 proper-lockfile 保护跨进程续传，等待锁可取消，成功后清理本次各来源 partial。JDK 归档改为按 SHA-256 保存在托管缓存，跨次失败可续传 |
| JDK/工具安装等待锁 180 秒先于下载失败 | 改为可取消的锁等待，保留心跳和过期锁恢复；下载自身仍有停滞检测与有限尝试 |
| Gradle ZIP 走镜像，但 Maven/插件仍直连 | 托管命令传 content-addressed init script；覆盖 pluginManagement、buildscript、settings dependencyResolutionManagement、项目/子项目仓库。Central→华为，Plugin Portal→阿里，Forge/Minecraft Maven→BMCLAPI；Sponge release→BMCLAPI。保留原仓库、私库顺序与认证；镜像传输失败可用项目原仓库重试一次，不把 Maven 故障当 Wrapper 故障重新下载 ZIP |
| Sponge SNAPSHOT 不能笼统替换 | 真实探测发现 BMCLAPI 对 mixingradle 0.7-SNAPSHOT 返回的 metadata 不是该坐标所需的标准 SNAPSHOT 文档。镜像使用 releasesOnly，SNAPSHOT 保留 Sponge 原仓库；已用真实 Gradle 解析 mixingradle 0.7-SNAPSHOT 与 mixin 0.8.5，确认前者原源、后者 BMCLAPI |
| ForgeGradle 自行下载原版 JAR / mappings | FG6 适配：先用原始 manifest/version SHA-1 与制品哈希准备 MinecraftRepo；从校验后的 userdev/MCP config 读取准确 MCP 版本与 joined 步骤，预热 MCPRuntime 二进制输出，使上游按原 SHA-1 复用。没有改写原版 JSON 中的 URL。版本/布局不支持或预热失败会留诊断并保留上游缓存路径与有限读取期限 |
| Maven 工具和 Central 依赖缺少国内路径 | Maven 3.9.9 ZIP 华为→Apache，固定使用 Apache 公布的 SHA-512；托管 global settings 镜像 Central，不覆盖用户 settings/私库。镜像获取失败可用原仓库重试一次 |
| 准备时间被算成游戏执行超时 | Gradle 验证从目标 run 任务开始计执行预算；隔离场景从首次服务端就绪后计场景预算。下载/编译不占原来的 150 秒准备总限额。保留执行及单步限制；HeadlessMC 就绪等待考虑新下载进度 |
| XMCL 处理器无字节输出被误判下载停滞 | 只跟踪下载叶任务，不用下载看门狗终止解压/CPU processor；保留取消、失败重试和无输出采栈诊断 |
| 日志多导致停服、截图传输容量不一致、固定 2 GiB 内存 | 保存日志到上限后标明截断，继续实时解析和执行，不再因日志量停止服务端；图像转发上限与 8 MiB 二进制 PNG 对齐并明确超量；原生测试按机器可用内存自动选至多 4 GiB，允许 maxMemoryMb 1024–16384 与客户端连接 readyTimeoutMs 配置 |

继续复用已有 DownloadManager、proper-lockfile、XMCL、Gradle/Maven 仓库机制及 yauzl 归档读取，没有新增下载框架或 Maven 解析器。FG6 只做按上游源码验证的缓存接入。

## 真实验证

下列全部使用隔离临时项目；未修改用户诊断包中的 npc 工程，未启动用户现有游戏。

| 范围 | 样本与结果 |
| --- | --- |
| 1.4 单独模组 | 随机选中 Sodium mc1.20.1-0.5.13-fabric，实际下载 971,552 字节，上游 SHA-1 / SHA-512 通过 |
| main 单独模组 | 随机选中 Lithium mc1.20.1-0.11.4-fabric，实际下载 691,483 字节，双哈希通过 |
| 1.4 整合包 | Adrenaline 26.5.1+mc1.21.1.fabric：真实 MRPack 下载、解包、调用生产导入服务下载 30 项，共 33,332,114 字节；逐文件验证全部清单哈希，再次导入下载 0 项 |
| main 整合包 | Fabulously Optimized 6.5.0：同样完整走通 50 项（含资源包），共 44,322,932 字节；逐文件哈希通过，再次导入下载 0 项。准确上游 versionId / version_number 以 live-downloads.json 为准 |
| 超过 300 秒的慢流 | 真实计时 localhost 持续慢流 312,679 ms，1 次尝试完成，文件哈希通过；这是传输期限机制实测，不冒充全国各运营商测速 |
| Forge 冷缓存完整编译 | Minecraft 1.20.1 / Forge 47.4.23 / ForgeGradle 6.0.54 / Gradle 8.12.1 / Java 17：新 Gradle home，从依赖解析、MCP steps、真实引用 Minecraft 类编译到 reobfJar/build，BUILD SUCCESSFUL，Gradle 报 12m 24s。说明首次准备确实可超过 300 秒 |
| FG6 MCP cache 消费 | 实际取得 userdev/MCP ZIP、验证并写入 joined 的 client/server/mappings；再用真实 Forge 构建消费预热缓存，BUILD SUCCESSFUL，5m 59s（依赖缓存复用，不能当严格性能对照）。client 与 server 步骤分别在同一毫秒和约 111 ms 内进入下一步，未重新传输几十 MB 原版文件 |
| Maven | 新工具/本地仓库目录下载 Maven 3.9.9，解析 Guava 31.1-jre 及构建插件，真实 javac/package 成 JAR，BUILD SUCCESS |
| Gradle 仓库兼容 | 8.4、8.12.1、9.5.1 实际进程执行 init script；验证 settings 仓库模式、插件仓库、buildscript、原私库及带认证仓库保留；另以 8.12.1 实跑 Kotlin settings/build 脚本。此项不表示 ForgeGradle 6 支持 Gradle 9 |
| MCP | 内嵌与独立 stdio→HTTP bridge 实调：启动、同 ID 查询、在途去重、取消、结果读取、功能禁用/只读边界；不是只检查工具名称存在。1.4 与 main 全 externalAgents 回归分别 206 / 208 通过 |
| 下载/生命周期回归 | 覆盖慢流、停滞、跨次取消续传、资源变化 HTTP 200 重下、缓存复用、等锁取消、取消准备不再构建、项目切换、日志超量后继续断言、CPU processor 不误停。最终逐套数量与类型检查结果见 verification.json |

实测过程纠正了仓库凭据 getter 的副作用（会制造空认证）、隐式 Plugin Portal 重复、MCP step 默认 name，以及 SNAPSHOT 镜像元数据不兼容；这些均已在最终源码修正，不能仅凭最早的空仓库列表测试宣称依赖解析成功。

## 仍保留的限制与验收边界

- 不是所有 URL 都已变成国内镜像。Sponge SNAPSHOT、FG6 MCPRuntime 的小型 manifest/version JSON、JDK 版本元数据、未知插件自己的网络请求仍可能访问上游；已保留诊断和有限单次请求/读取期限。Modrinth 文件使用其上游 CDN，本机两个分支的真实导入通过，不承诺所有国内网络均可用。
- 体积、像素、归档展开、文件数和单步操作上限没有一律删除。通用文件默认 512 MiB，JDK 按可信大小扩展；MRPack 远程合计 2 GiB、本地导入 8 GiB / 100,000 文件、固定服务端输入 64 JAR / 合计 1 GiB 等保护仍在。FG6 适配元数据归档最多 32 MiB，归档 JSON 读取复用既有 16 MiB 保护。超限应明确报错，不能当作网络超时。
- 场景执行/连接/命令仍有各自预算；原有其他服务端管理入口并非全部转换为后台任务。本文后台化范围为 test_session 准备及 test_matrix / test_minecraft / test_rendered。
- 验证了真实下载、依赖解析、编译和传输机制；没有对上述两个整合包逐项做可见游戏玩法验收，没有覆盖用户私有 5 个 Mod 的完整 NPC 行为，也没有证明所有 Minecraft/Loader/Gradle 组合。
- 本轮改的是源码工作树；未签名、打包、上传或发布安装包。也未做积分账单逐笔核对、退费或改动积分服务，不能承诺已扣积分自动退回。

上游依据：[ForgeGradle MinecraftRepo](https://github.com/MinecraftForge/ForgeGradle/blob/FG_6.0/src/common/java/net/minecraftforge/gradle/common/util/MinecraftRepo.java)、[MCP DownloadFileFunction](https://github.com/MinecraftForge/ForgeGradle/blob/FG_6.0/src/mcp/java/net/minecraftforge/gradle/mcp/function/DownloadFileFunction.java)、[MCPRuntime](https://github.com/MinecraftForge/ForgeGradle/blob/FG_6.0/src/mcp/java/net/minecraftforge/gradle/mcp/util/MCPRuntime.java)、[Apache Maven 3.9.9 ZIP SHA-512](https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip.sha512)。

证据：[验证汇总](download-recovery-20261028/verification.json)、[真实下载](download-recovery-20261028/live-downloads.json)、[冷缓存构建](download-recovery-20261028/forge-build.json)、[预热后构建](download-recovery-20261028/forge-seeded-build.json)、[Sponge 真实解析](download-recovery-20261028/sponge-gradle.json)、[时长/容量原审计](audits/2026-10-27-download-limits.zh-CN.md)。

证据目录中的脚本保留本机复验入口，使用本文记录的托管 JDK/Gradle 与两个工作树路径，默认不参与常规测试；复验需相同环境。慢流脚本先依赖真实下载脚本生成生产服务 bundle。JSON 中保存具体 versionId、文件哈希、步骤时间与原日志位置；历史失败探测和修正过程没有冒充最终通过结果。
