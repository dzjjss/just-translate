# 状态清单：v0.16.8

这份清单覆盖 src 全部 JS 文件，列出跨作用域可变绑定、容器、观察器、计时器和记录字段。原先的 41/36 只覆盖 main、PageSession、Scheduler 的一小部分，不能与下面的数字混用。

## 可复测基线

| 口径 | v0.16.7 | v0.16.8 |
| --- | ---: | ---: |
| 跨调用可变绑定/资源定义 | 98 | 100 |
| 上述对象展开的直接字段 | 49 | 49 |
| 请求、扫描期间的闭包变量/资源定义 | 20 | 20 |
| 上述临时对象直接字段 | 6 | 6 |
| 已识别记录结构 | 14 | 14 |
| 记录字段定义 | 99 | 99 |
| 单元写入的文件×字段组合 | 5 | 5 |

v0.16.8 新增两项长期定义。`event-log.js` 的 `writeFailures` 保存尚未能写进 `storage.session` 的失败次数，下一次成功写入时折进日志；没有这个短暂的内存补偿，存储恢复后会把证据缺口伪装成完整日志。`popup.js` 的 `actionTimers` 为三个工具按钮各保留一个计时器句柄，连续点击会取消旧计时器，避免旧反馈提前覆盖新反馈。Map 的 key 集合是固定的三个按钮，回调完成后删除。

本轮没有把计时器回调捕获的按钮节点登记成长期状态：实现改为命名回调按 id 重新取节点，按钮只在一次 `flashAction` 调用期间存在。扫描脚本和 `TRANSIENT` 清单未改；100 是实测净值。

必须说清楚的口径边界：验收日志的内容存在 `chrome.storage.session`，静态扫描只数代码里的绑定，数不到存储里的条目。所以 100 没有覆盖最多 240 条事件及其 `writeFailures` 记录字段；它们受环形上限与浏览器会话周期约束。

100 不代表运行时同时有 100 个实例；关闭先例时，其工厂定义仍在清单中，实际不创建先例 Map 或计数器。v0.16.5 删除 popup 的 `dirtyGroups`、保存队列和画像文本副本，v0.16.6 为日志串行写入增加 `lifecycleWrites`；历史基线继续保留供对照。

计数分开报告，不能直接相加成“总状态”：容器绑定和容器内字段属于不同层级，同一条记录也可能有多个实例。每个定义的文件、所有者、类型和字段见 `state-baseline-v0.16.8.json`；旧 JSON 保留用于对照。本轮扫描脚本未改，仍为同一口径。

## 范围与限制

- 检查模块级写入和被闭包引用的可变局部变量，包括 const Map/WeakMap、观察器与计时器；只读常量表不计作活动状态。
- 展开可静态识别的对象字段，包括 translationRuntime、tokens、errorStreak、以及缓存、会话、单元、术语、先例、诊断和默认设置记录。
- DOM 引用和扩展直接修改的属性纳入清单；不展开浏览器内部 DOM 树。函数参数传入的对象内部由其所属记录结构计数。
- 请求/扫描作用域分类经过人工列举；新增回调默认为保留项，必须复核生命周期，不能靠改分类压低数字。
- 静态分析不能证明不存在动态属性、别名写入或外部存储状态。记录结构识别规则需随新增存储形式审查，清单不能替代取消、过期提交等行为测试。

## 按模块查看

| 文件 | 跨调用绑定 | 直接字段 | 记录字段 |
| --- | ---: | ---: | ---: |
| src/background/cache.js | 6 | 0 | 3 |
| src/background/event-log.js | 2 | 0 | 0 |
| src/background/machine-translation.js | 0 | 0 | 3 |
| src/background/preflight-cache.js | 0 | 0 | 3 |
| src/background/providers/openai.js | 1 | 0 | 0 |
| src/background/queue.js | 3 | 0 | 4 |
| src/background/router.js | 1 | 0 | 0 |
| src/background/service-worker.js | 1 | 0 | 0 |
| src/background/sessions.js | 1 | 0 | 2 |
| src/background/translation-cache.js | 0 | 0 | 2 |
| src/background/translator.js | 1 | 0 | 0 |
| src/content/connection.js | 1 | 0 | 0 |
| src/content/extractor.js | 1 | 0 | 11 |
| src/content/float-widget.js | 13 | 9 | 0 |
| src/content/hud.js | 2 | 2 | 0 |
| src/content/main.js | 12 | 28 | 6 |
| src/content/observer.js | 2 | 0 | 0 |
| src/content/renderer.js | 2 | 2 | 0 |
| src/content/semantic-memory.js | 8 | 0 | 8 |
| src/content/session.js | 13 | 5 | 0 |
| src/content/term-consistency.js | 3 | 0 | 17 |
| src/content/translation-scheduler.js | 7 | 0 | 0 |
| src/content/ui-host.js | 5 | 1 | 0 |
| src/popup/popup.js | 6 | 2 | 0 |
| src/popup/settings-form.js | 3 | 0 | 0 |
| src/shared/constants.js | 0 | 0 | 35 |
| src/shared/diagnostics.js | 4 | 0 | 5 |
| src/shared/logger.js | 1 | 0 | 0 |
| src/shared/settings.js | 1 | 0 | 0 |

## 增长检查

`npm run audit:state` 输出当前明细；`node test/state-inventory.test.mjs` 检查新绑定、字段或生命周期变化是否已登记。允许删除旧状态，不允许未说明的新状态自动通过。更新 JSON 基线时，应在维护记录写明所有者、保留多久、为什么不能从现有数据派生。

本轮清单没有将常规文案、显示视图模型或 API DTO 都视为额外运行状态。`createSettingsForm` 的 `saved`、`providerId`、`drafts` 都与面板同寿命，`form` 是管理器引用；这些位置已逐项登记，不改变成临时分类来压低数量。诊断模块没有长期可变定义。
