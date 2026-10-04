# 模型选型核查

核查日期：2026-10-02。范围为供应商 2 的 17 个付费型号与可用免费套餐的 4 个型号；已废弃的供应商 1 不参与选择。页面保留一句推荐语，证据与价格细节留在本文。

## 判断原则

官方文档用于确认型号、任务定位与标准单价；Artificial Analysis 的独立评测用于交叉检查能力、速度和任务成本。单个综合分数不证明每项任务都胜出，社区热度也不能证明严格上位。下面的“优先”表示当前开发用途的选型建议，不表示旧模型在所有任务上失去优势。

价格为美元 / 百万 tokens，普通文本标准输入（未命中缓存）与输出；不含工具、缓存写入、长上下文、Fast、税费等。官网与 OpenRouter 的不同供应商报价可能不同，不混用。ModMind 按上游线路规则扣费，厂商价格不能直接视为 ModMind 最终价格。

## 替代关系与性价比

| 关系 | 证据与结论 |
| --- | --- |
| GPT-6.1 Sol 与 GPT-6 Sol | OpenAI Docs 将 6 Sol 指向更新的 6.1 Sol；6.1 官方定位为接近 Astra 的复杂编程能力。标准输入 / 输出同为 $2 / $10，6.1 缓存读取 $0.10，6 Sol 为 $0.20。优先推荐 6.1，但实际路由可能从 50% 混池变成约 75% MAX，不能宣称切过去一定更便宜。 |
| GPT-6.1 Sol 与 GPT-5.6 Sol / GPT-5.5 | 6.1 为当前主力候选；官网标准价格 $2 / $10，5.6 Sol 当前优惠 $4 / $20（至少到 2026-11-21），5.5 为 $5 / $30。官方单价下降，保留替代建议；没有将第三方更低的 5.6 报价当成官方价。 |
| GPT-6 Luna 与 GPT-5.6 Luna | 新 Luna 的官方定位是高吞吐、明确任务的最高效率型号；$0.10 / $0.50，旧 Luna 为 $0.20 / $1.20。可建议省额度时优先新 Luna，不声称每个质量指标都领先。 |
| GPT-6.1 Sol 与 GPT-6 Astra | Astra 为高难度任务旗舰，Sol 接近其能力；官网标准 $2 / $10 对 $10 / $50。属于成本与能力层级取舍，Sol 不是 Astra 的严格上位。复杂任务保留 Astra。 |
| GPT-5.6 Terra | 官方定位为能力与成本均衡的 mini 档，$2 / $12。现有混池可用，不能仅凭 6.1 的输出官方单价更低就判为全局上位或扣费更低；保留正面定位。 |
| Gemini 3.8 Flash 与 3.7 / 3.6 Flash | 官方将 3.8 定位为最强 Flash，旧型号为上一代；AA 独立 high 评测分别为 41 / 39 / 34 分。当前三者标准价均为 $0.75 / $3.75。3.7 测得约 298 tokens/s，3.8 约 245 tokens/s；AA 每任务成本约 $0.93 与 $1.24，3.8 更长的输出抵消部分单价优势。优先 3.8 做复杂开发，保留 3.7 的速度用途；不是所有维度的严格上位。 |
| Gemini 3.1 Pro Preview | 官方为推理与多模态 Pro，$2 / $12。Flash 后续型号性价比更好，但没有充分证据证明所有长文、多模态任务被完全取代；保留正面推荐语。 |
| Grok 4.7 与 4.6 / 4.5 | 4.7 为官方编程与 Agent 旗舰，公开目录与 AA 均明确继任关系。普通输入 / 输出三者均为 $2 / $6；AA high 为 46 / 44 / 39 分。4.7 high 的每任务成本约 $2.73，高于 4.6 的 $1.86 与 4.5 的 $1.04；复杂任务优先新版，不写成全面更便宜。4.5 的缓存读取 $0.30 还低于新版的 $0.50。 |
| DeepSeek V4.1 Flash 与 V4 Pro 0813 | 官方 4.1 原生多模态，AA max 为 39 对 36 分，输出速度约 209 对 81 tokens/s。峰时 $0.30 / $1.20 对 $1.32 / $3.96，非峰时均减半。当前开发与性价比优先 Flash 的依据成立；上游这两个选项都属于免费套餐，不将厂商价差当作免费版费用差。 |
| GLM 5.3 Flash 与 GLM 5.3 | 官方 Flash 为原生多模态、低成本编程与长程任务型号，$0.15 / $0.50；5.3 为复杂编程旗舰，$1.40 / $4.40。AA 为 Flash 42 与 5.3 max 45 分。任务层级互补，不能写成 Flash 弱到只适合小脚本，也不判 5.3 被全面替代。ModMind 当前 Flash 付费，5.3 免费，两者的用户费用排序与官网相反。 |
| Kimi K3 | 官方定位为长程编程、知识工作、推理、多模态与 1M 上下文；AA max 44 分。官网 $3 / $15，当前 ModMind 线路 200% 且无缓存。能力描述不再局限于读长文；没有已开放的同系列上位，保留正面推荐语，但不列为省额度默认项。 |
| Qwen 3.8 Flash | OpenRouter 对 exact ID 的定位为多模态推理、编程、Agent、文档与代码库分析，报价 $0.15 / $0.47。当前免费套餐可以单独选择。AA 的 Qwen3.8-Flash-Next 不等于此 exact ID，不能借其成绩判断本型号；保留正面描述，不虚构上位关系。 |

Gemini 3.6 / 3.7 / 3.8 的上述优惠价官方注明持续至 2026-12-31，2027-01-01 标准输入 / 输出变为 $1.50 / $7.50；不将临时优惠硬编码进产品价格。

## 上游线路与缓存

当前 `/api/device/group` 的供应商 2 标签：混池 50%，MAX 约 75%，企业约 130%，Astra 专用约 95%，Kimi 200%，GLM 175%，Gemini 标准价，Grok 45%。自动切换会先保留能提供 exact ID 的当前线路，否则按已有路由提示寻找已开放分组，未增加价格猜测或收费探测。

只有 Kimi 与 Gemini 线路明确写着“无缓存”。这不否认厂商原生 API 的缓存能力，而是该上游线路的声明。每个 Kimi / Gemini 付费选项显示“无缓存”，家族不显示；免费版按自身套餐声明判断。GLM、Grok、GPT 与当前免费套餐未明确标注，不推断。强制刷新目录会重新计算，MCP 与界面返回一致。

## 页面推荐语

| 型号 | 一句推荐语 |
| --- | --- |
| GPT-6.1 Sol | 接近旗舰能力的全能主力，适合日常开发、写代码和排错。 |
| GPT-6 Astra | 旗舰推理模型，适合高难度开发、重构和复杂建模。 |
| GPT-6 Luna | 省额度的高速模型，适合明确的小任务、代码修改和讨论。 |
| GPT-6 Sol | 主力编程模型，追求更强能力可选 GPT-6.1 Sol。 |
| GPT-5.6 Sol | 上一代主力模型，建议优先使用 GPT-6.1 Sol。 |
| GPT-5.6 Terra | 均衡型编程模型，适合日常开发、代码修改和任务讨论。 |
| GPT-5.6 Luna | 低成本轻量模型，省额度建议优先使用 GPT-6 Luna。 |
| GPT-5.5 | 较早的通用模型，建议优先使用 GPT-6.1 Sol。 |
| Gemini 3.8 Flash | 高速多模态主力，适合写代码、分析项目和连续执行任务。 |
| Gemini 3.7 Flash | 高速编程模型，复杂任务建议优先使用 Gemini 3.8 Flash。 |
| Gemini 3.6 Flash | 上一版 Flash，日常开发建议优先使用 Gemini 3.8 Flash。 |
| Gemini 3.1 Pro Preview | 擅长长文推理与多模态分析，适合阅读项目和梳理方案。 |
| Grok 4.7 | 擅长持续编程与问题分析，适合复杂开发、排错和方案执行。 |
| Grok 4.6 | 上一版编程主力，复杂任务建议优先使用 Grok 4.7。 |
| Grok 4.5 | 较早的编程模型，复杂任务建议优先使用 Grok 4.7。 |
| Kimi K3 | 擅长长程编程与知识工作，适合大型项目分析和复杂任务。 |
| GLM 5.3 Flash | 低成本多模态编程模型，适合日常开发、看图和长任务。 |
| DeepSeek V4.1 Flash（免） | 高性价比的主力模型，适合复杂开发、代码分析和排错。 |
| DeepSeek V4 Pro（免，exact ID: deepseek-v4-pro-0813） | 较早的推理模型，建议优先使用 DeepSeek V4.1 Flash。 |
| GLM 5.3（免） | 复杂编程与推理主力，适合大型代码修改和长程任务。 |
| Qwen 3.8 Flash（免） | 高性价比多模态模型，适合写代码、分析文档和看图。 |

## 来源

以下来源均实际读取，不能把搜索片段、模型编号或厂商宣传的单项分数当成全部任务的结论。

- OpenAI Docs：[6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[5.5](https://developers.openai.com/api/docs/models/gpt-5.5)、[价格](https://developers.openai.com/api/docs/pricing)。
- Google：[模型目录](https://ai.google.dev/gemini-api/docs/models)、[3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[价格](https://ai.google.dev/gemini-api/docs/pricing)。
- SpaceXAI：[Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)、[发布记录](https://docs.x.ai/developers/release-notes)。
- DeepSeek：[发布记录](https://api-docs.deepseek.com/updates)、[当前价目表](https://api-docs.deepseek.com/quick_start/pricing)。
- Z.ai：[5.3 Flash](https://docs.z.ai/guides/llm/glm-5.3-flash)、[5.3](https://docs.z.ai/guides/llm/glm-5.3)、[价格](https://docs.z.ai/guides/overview/pricing)。
- Moonshot：[Kimi K3](https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart)、[价格原文](https://platform.moonshot.ai/docs/pricing/chat.md)。
- 独立评测：[AA 当前榜单](https://artificialanalysis.ai/leaderboards/models)、[3.8](https://artificialanalysis.ai/models/gemini-3-8-flash)、[3.7](https://artificialanalysis.ai/models/gemini-3-7-flash)、[3.6](https://artificialanalysis.ai/models/gemini-3-6-flash)、[Grok 4.7](https://artificialanalysis.ai/models/grok-4-7)、[4.6](https://artificialanalysis.ai/models/grok-4-6)、[4.5](https://artificialanalysis.ai/models/grok-4-5)、[DeepSeek 4.1 Flash](https://artificialanalysis.ai/models/deepseek-v4-1-flash)。
- 跨厂商报价与 exact ID 辅助核查：[OpenRouter 公开目录](https://openrouter.ai/api/v1/models)、[models.dev](https://models.dev/api.json)。Qwen 此处依据 exact ID 公开目录与阿里云模型列表，未取得可对应的独立实测分数。

## 验证与边界

路由测试覆盖明确标签、刷新移除标注、当前线路优先、同 ID 付费与免费声明隔离；真实 MCP stdio 调用确认字段返回。隐藏 Electron 隔离配置的界面测试检查型号与当前型号标识、家族零标识、浅深主题及 1440 / 600 / 390 px、切线、失败重试和断网。真实账号只读查询确认 21 个选项，不发起收费推理。

这些评测与价目表不能证明当前转发线路每次都具有厂商直连的全部质量，也不能替代 ModMind 项目任务的长期体验。未执行付费质量跑分；正文不加入适配警告，不引入新依赖。
