# v0.16.7：验收入口的可用性修正

在 v0.16.6 发布包对应工作树上继续，未提交或推送。安装包根目录包含 manifest.json。验收日志本身的设计见 MAINTENANCE-v0.16.6.md。

本轮修的全部是 v0.16.6 自己引入的问题，来源是第一次真实浏览器取证。翻译规则、prompt、调度、正文提取和渲染源码未改，PROMPT_VERSION 仍为 13。

## 真实使用暴露的四个问题

**一、复制没有反馈。** setStatus 写的是 #status，它在 homeView；而验收按钮在设置视图的「工具与高级」里，点的时候首页视图是 hidden，状态栏根本不在屏幕上。旁边的「复制本次诊断」之所以有反馈，是因为它额外改了按钮自身的文字，加新按钮时没沿用这条约定。证据是取证日志里 4 秒内出现 9 条 log-exported——用户连点九次才确认有没有生效。

现在抽出 flashAction，三个按钮统一在自身显示结果并在 1.6 秒后还原；setStatus 保留为首页可见时的补充。架构测试固定了这条约定：工具区的动作只调 setStatus 会失败。

**二、复制会污染它要复制的日志。** 验收复制走 GET_DIAGNOSTICS，而内容脚本在响应时会记一条 log-exported 作为交接水位。于是每复制一次就往页面日志里塞一条噪声，取证日志 20 条里 9 条是它；页面日志环形上限 80 条，多复制几次就会把真事件挤掉。

现在这条读取带 passive 标记：一次性复制仍留水位（它的语义就是导出即交接），验收复制只取快照、不记事件。

**三、摘要口径误导。** acceptance 之前把 wholePageCacheHit 等字段平铺在顶层，取值只来自最后一次页面会话。实际取证里后台日志明确记着一次 requests: 0 / wholePageCacheHit: true 的命中，而摘要显示 false——因为最后一次操作是「重翻」，它主动绕过缓存。

现在拆成两段：logWindow 覆盖本段日志里的所有会话（translateChunks、cacheHitChunks、providerRequests、failedUnits、failureCategories），currentPage 只描述最后一次页面会话。note 里明写两者不一致是正常的，不要只看其中一个下结论。

**四、失败批次没有原因。** 取证日志里有一条 failed: 7 / requests: 3，但只有数字，事后无法判断是超时、限流、响应格式坏了还是模型漏条目。现在 translate-chunk 带 failureCategory：有 execution 失败就用 classifyDiagnosticError 分类，否则按 sourceLimitFailedUnits / invalidResponseFailedUnits 区分，都不是就记 missing-items。

## 排版

`.diagnostic-copy` 和 `.danger-soft` 这两个语义类同时兼职 `grid-column: 1 / -1`，所以新按钮复用 diagnostic-copy 之后被拉成整行，旁边的清空按钮只占一列，右边空一格。跨列职责拆成独立的 `.span-all`，两个验收按钮并排；验收组包进 action-subgroup，用分隔线和间距让说明贴住它解释的那组按钮，说明文字压缩到三行。架构测试禁止语义类重新兼职布局。

## 同口径指标

| 指标 | v0.16.6 | v0.16.7 |
| --- | ---: | ---: |
| src JS 文件 | 59 | 59 |
| src JS 物理行数 | 9,548 | 9,596 |
| 函数，含回调与 getter | 939 | 947 |
| P90 / P95 classic CC | 9 / 13 | 9 / 13 |
| 最大 CC / CC >20 函数 | 20 / 0 | 20 / 0 |
| 全 src 长期可变绑定/资源定义 | 98 | 98 |
| 上述对象直接字段 | 49 | 49 |
| 测试用例 | 325 | 331 |

长期状态没有增减。flashAction 最初把按钮节点闭包进定时器，扫描判为保留项（+1 绑定、+2 字段）；改成回调里重新取节点后不再产生跨调用绑定。是改代码让判定成立，不是把它加进 TRANSIENT 豁免名单压低数字。

## 验证

lint 与 **331 个用例（20 个测试文件）通过**，新增 6 个：

- test/content.test.mjs：被动读取反复五次不改变事件序列，一次性复制仍留下 log-exported 水位。
- test/backend-lifecycle.test.mjs：200 响应但零条目的批次，拆分重试跑满后在日志里记为 missing-items，成功批次不带类别。
- test/popup.test.mjs：logWindow 与 currentPage 分开判读，整段日志里的缓存命中不被最后一次重翻盖掉；复制按钮自身显示条数；清空失败时按钮显示失败。
- test/architecture.test.mjs：跨列必须走 .span-all，语义类不得兼职布局；工具区三个按钮必须调 flashAction；验收读取必须是 passive。

## 尚待完成

1. **后台回收那条仍未取证。** 首次实测里两条 worker-start 相隔 3 分钟且都排在所有会话之前，看形态是重新加载扩展，不是空闲回收；pageReconnects 为 0，说明没有会话跨越过后台重启。仍需按步骤跑：翻完后关闭面板与 worker DevTools，切走五分钟再回来追加正文。
2. **缓存那条已经通过。** 00:40:42 一组 session-open → preflight reused → translate-chunk requests: 0 / wholePageCacheHit: true，刷新后重翻零供应商请求。这条可以从待办里划掉，但只是单页单次。
3. **token 预算模型待多点采样。** 同一页两次实测输入都是 1667（估算 3532，估高 2.12 倍，确定不是抖动），输出分别是 945 和 650（同样输入相差 45%）。每字符输出系数实测 0.56 与 0.38，假设值 0.36 落在区间低端。单页样本不足以调常数，但输出阈值只留 25% 余量，相对这个抖动幅度偏薄。继续按页记录 estimatedInputTokens / estimatedOutputTokens 与 tokens.input / tokens.output，攒够再一起调。
