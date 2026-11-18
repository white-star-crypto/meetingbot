# 需求：MeetingBot 自己的下一版路线

MeetingBot 是一个多模型设计会议工具，不是多 Agent 编码框架。

当前已实现：

- 多模型独立提案：理解 / 架构 / 审美 / 风险 / 置信度
- 提案匿名化为 P1..Pn
- 每个参会模型给所有提案打分和排名
- 按平均分 + 第一名次数选出包工头
- 包工头只能因 safety / scope / budget / infeasible / conflict 否决
- 审美分歧必须进入 merge_plan，不能被一票抹掉
- CLI、Mock 模式、HTML 报告
- 自定义 OpenAI-compatible provider add/list/test
- 参会选择：--agents / --count / --exclude / --require-tags / --max-cost-tier
- provider 失败时可用 fallbacks 替补

当前限制：

- 投票只是简单平均分，没有自投降权、置信度加权、Condorcet
- 没有会前成本估算，只有 costTier 人工标签
- 没有完整的会议 UI，只有 CLI + 静态 HTML
- 没有 builder 阶段，不能把决策变成代码
- 没有多模态终审
- provider 429/超时会降低参会质量
- 真实项目验证只有 2 次，样本小
- 会议 prompt 还比较通用，缺少按需求类型自动选模板

约束：

- 不引入重型框架
- 保持零依赖优先
- 不自动执行代码、不改仓库
- 任何优化必须能说明它如何提升“决策质量”或“成本效率”
- 先做能验证的，不要堆概念

请提出你们认为最值得的下一步优化，并说明为什么它比其他优化更优先。
