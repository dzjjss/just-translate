# v0.16.6：验收日志

在 v0.16.5 发布包对应工作树上继续，未提交或推送。安装包根目录包含 manifest.json。popup 草稿与保存边界的前轮报告保留于 MAINTENANCE-v0.16.5.md。

本轮只做一件事：让浏览器生命周期与缓存验收拿得出证据。翻译规则、prompt、调度、正文提取和渲染源码与 v0.16.5 包一致，PROMPT_VERSION 仍为 13。

## 为什么原来的入口不够

「复制本次诊断」复制的是内容脚本内存里的一次性日志。它随页面会话建立，页面刷新即重置；后台 service worker 被回收时页面侧只留下一条 session-reconnected，后台自己发生过什么完全没有记录。而验收要证的恰好是这两件事：

- 切走五分钟回来，后台到底被回收了没有。页面日志无法区分「没被回收」和「被回收后重连成功」。
- 翻译、等缓存落盘、刷新、再翻译，两次的 translateRequestCount 与 wholePageCacheHit 需要放在一起比，而刷新已经把第一次的日志清掉了。

所以缺的不只是按钮，是一份能跨页面刷新和跨 worker 回收存活的日志。

## 本轮完成的工作

- 新增 src/background/event-log.js。后台事件写入 chrome.storage.session：service worker 被回收不影响它，浏览器关闭时自动消失，不落磁盘，默认不对内容脚本开放。单一写入链串行落盘，环形上限 240 条，超出部分丢最旧的并在 droppedBefore 里如实报告丢了多少。内容仍过 sanitizeDiagnosticValue，Key、正文、prompt、URL query 与 hash 不入库。
- 记录点八个：worker-start（带 epoch，日志里出现第二条就是后台被回收过的直接证据）、session-open、session-expired、session-abort、translate-chunk（items / requests / wholePageCacheHit / failed）、translate-failed（错误类别）、preflight（reused 与来源）、permission-removed。记录不阻塞请求路径，写入失败只返回 null，不会反过来打断翻译。
- 面板「工具与高级 → 维护与导出」新增「复制验收日志」与「清空验收日志」。复制产出一份 JSON：面板可见的引擎与权限状态、后台生命周期事件、当前页面的一次性诊断，以及一个由事件派生的 acceptance 摘要（workerStarts、backgroundRecycled、sessionExpired、sessionAborts、pageReconnects、translateRequestCount、wholePageCacheHit、preflightHash 与 preflightReused）。摘要标注了「由事件派生」，不是另外维护的一份状态。
- 复制不清空任何一侧。同一段证据可以反复复制，也可以先复制再继续操作；要开始新一段取证时才点清空，清空是显式动作。这与「复制本次诊断」的一次性语义相反，两个按钮各自的说明写在按钮下方。
- 两条新消息 GET_LIFECYCLE_LOG 与 CLEAR_LIFECYCLE_LOG 进入 PANEL_ONLY 白名单，页面无法读取或清空验收日志。

## 同口径指标

| 指标 | v0.16.5 | v0.16.6 |
| --- | ---: | ---: |
| src JS 文件 | 58 | 59 |
| src JS 物理行数 | 9,374 | 9,548 |
| 函数，含回调与 getter | 911 | 939 |
| P90 / P95 classic CC | 9 / 14 | 9 / 13 |
| 最大 CC / CC >20 函数 | 20 / 0 | 20 / 0 |
| 唯一静态依赖边 | 133 | 136 |
| 全 src 长期可变绑定/资源定义 | 97 | 98 |
| 上述对象直接字段 | 49 | 49 |
| 测试用例 | 312 | 325 |

这一轮是净增加：多了一个文件、174 行、28 个函数、3 条依赖边和 1 项长期状态。换来的是一类此前无法取证的场景可以取证，不是代码变简单了。lifecycleWrites 是新增的那项长期定义，形态与 settings.js 的 settingsWrites 相同，作用是串行落盘。

口径边界需要说明：静态扫描数的是代码里的绑定，数不到 storage.session 里的日志条目。98 这个数字不包含那份日志本身，它由 MAX_EVENTS = 240 和浏览器会话周期约束。把存储里的数据算作零状态是不诚实的，所以这里明写出来。

## 验证

lint 与 **325 个用例（20 个测试文件）通过**，新增 13 个：

- test/event-log.test.mjs（6 个）：并发写入串行且序号连续、超上限丢最旧并如实报告丢弃量、Key 与正文与 query 不入库、清空后从零开始、缺 storage.session 时退回 local、读写失败不抛给调用方也不污染写入链。
- test/restart.test.mjs（新增 3 个）：在真实模块启动的独立 Worker 里销毁后台四次，日志第一条仍在、四条 worker-start 的 epoch 互不相同、缓存命中批次带 wholePageCacheHit 为真且 requests 为 0、日志不带出 Key、取证本身零供应商请求；清空由用户显式发起；内容脚本读取或清空一律 forbidden。
- test/popup.test.mjs（新增 2 个）：合成包结构与 acceptance 摘要判读正确、复制不清空页面日志、不泄漏未保存的 Key 草稿；后台日志取不到时仍复制页面部分并标记 unavailable，清空失败明说失败。
- test/architecture.test.mjs（新增 2 个）：面板入口与说明文案存在、存储键只出现在 event-log.js、两条消息必须是 panel-only。

Chrome API 仍是桩，DOM 仍是 jsdom。Worker 销毁重建可以验证「日志跨后台重启存活」这条属性，但不等于 Chrome 真实回收时序已经验收。本轮未重测覆盖率，不沿用前轮数字。

## 尚待完成

1. **真实浏览器取证。** 代码这边现在能产出证据了，证据本身还没有。四个场景仍需在真实 Chrome 里跑一遍，操作步骤见下。
2. **真实重复访问缓存与模型基线。** 同上，等第一份验收日志出来再判断。
3. **后续代码治理。** 提取器与 YAML 解析器的分组夹具及分支收束继续保留。

### 浏览器验收操作

使用包内 test/fixtures/lifecycle.html。在项目目录运行 python -m http.server 8765 --bind 127.0.0.1，打开 http://127.0.0.1:8765/test/fixtures/lifecycle.html；加载当前扩展，选择英语以外的目标语言。

每个场景开始前点一次「清空验收日志」，结束后点「复制验收日志」并保存。四个场景与 v0.16.5 一致：

- 翻完基础页，关面板与 worker DevTools，切走五分钟，回来追加一段正文。看 acceptance.workerStarts 是否大于 1、pageReconnects 是否大于 0。
- 刷新并追加长页面内容，开始翻译后中途切走五分钟。返回核对进度与日志；提前完成只能记录为正常完成。
- 开启缓存与整页优先，普通翻译、等缓存落盘、刷新后再普通翻译。两次的 translate-chunk 事件都在同一份日志里，直接比 requests 与 wholePageCacheHit。不要用重翻按钮测命中。
- 翻译途中停止，等后台空闲后返回。日志里应有 session-abort，旧任务不应自行复活。

workerStarts 只统计日志窗口内的启动次数：清空之后如果后台一直没被回收，它就是 1，这不算失败，只说明这次没触发回收。
