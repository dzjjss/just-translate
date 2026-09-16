# 状态清单：v0.17.7

同一 inventory 口径：长期分类定义/直接字段 **107/55 → 112/57**，请求/扫描 **20/6**，记录结构/字段 **14/99**，单元写入 **5/0**。统计脚本、分类规则与复杂度门禁未修改；当前基线为 `state-baseline-v0.17.7.json`。

| 所有者 | 状态及生命周期 |
| --- | --- |
| popup / createPopupNotice | 一个关闭计时器、最近交互控件引用、消息节点及其 DOM 字段；新提示取消旧计时器，悬停/聚焦暂停，错误无自动关闭计时器；面板关闭即释放全部引用 |
| markdown-export / buildBilingualMarkdown | 导出函数调用内去重 Set，导出完成即释放，不保留任何页面注册表 |
| markdown-export / tableGrid | 导出表格时决定保留行的局部数组，函数返回即释放 |

后两项被现有静态脚本按闭包引用列在 retained 分类，不代表它们跨导出调用持久存在；本次未为降低指标而改动分类。排序路径、表格网格及其它局部 Set 同样仅在单次导出内创建，未增加单元/缓存/会话状态、存储字段或轮询。

---

## v0.17.6 历史记录

本次新增共享 UI 反馈层，删除 popup 的 `actionTimers`。按未变更的 inventory 口径，长期可变定义/直接字段由 **102/50 → 107/55**；请求或扫描期仍为 **20/6**；记录结构/字段仍为 **14/99**。新基线 `state-baseline-v0.17.6.json` 保留此前门禁，所有翻译会话和缓存状态归属不变。

| 所有者 | 状态及释放 |
| --- | --- |
| action-feedback / jobs | WeakMap 持有每按钮的 pending、原 aria-label 与反馈定时器；结果 2.4 秒后或草稿改变时删除；弱键不形成永久 DOM 注册表 |
| action-feedback / locks | 正在执行的操作组；在 finally 删除。同一页面 realm 的 HUD/FAB 共用，popup 使用独立 realm |
| createActionFeedback / sequence | 每个界面实例的结果序号；较早操作无权覆盖新结果，没有轮询 |
| run / record | 一次操作及短暂结果阶段；任务完成释放组锁，旧结果定时器通过对象身份检查，不清除后来结果 |
| waitForReply / timer | 单次 Promise 等待截止时间；成功、拒绝和超时均 clearTimeout；不执行自动重发 |
| float-widget / flash.tip | 既有提示节点引用增加 tone 属性；随提示定时器或宿主销毁释放 |
| popup / onExportMd.a | 下载节点临时由 1 秒计时器持有，以便延迟释放对象 URL |

静态扫描把跨回调持有的请求期计时器也列为 retained，这是既有分类规则；此处不把它解释为永久运行状态。反馈元数据只存在扩展拥有的按钮 DOM 中，不写入持久设置或页面译文节点。

---

# 状态清单：v0.17.5

v0.17.5 沿用 v0.17.4 的扫描器、分类表和基线，长期可变定义/直接字段仍为 **102/50**；请求或扫描期仍为 **20/6**，记录结构/字段仍为 **14/99**。没有页面语言检测状态、计时器或源语言缓存。`targetLang` 仍是唯一持久语言字段；界面语言现算，HUD 读取主控制器提供的翻译函数。语言和消息目录是只读常量。模型草稿仍由 DOM 控件与原有表单账户草稿拥有，原生 select 的选项替代旧 datalist，不新增 JS 模型列表缓存。DOM 内部选项实例数不包含在此静态计数内。

相对 v0.17.3（沿用 v0.17.0 的状态基线），长期可变定义 100 → 102，直接字段 48 → 50。扫描脚本与分类表没有变化；新基线为 `state-baseline-v0.17.4.json`，旧文件保留。

| 新增所有者 | 保存什么 | 写入与释放 | 必要性 |
| --- | --- | --- | --- |
| observer.js / createMutationWatcher.events | 一个 AbortController 绑定 | start/重扫时替换并 abort 旧监听，stop 时 abort 并置空 | 一次释放 document 与各开放根的事件监听，无需另存根集合 |
| shadow-styles.js / styles | loading Promise、共享 CSSStyleSheet 两个字段 | 首次组件译文读取包内 CSS；页面生命周期内复用，清除时解除所有仍连接根的样式引用 | 合并并发读取并共享编译结果，避免每个根重复加载或编译 |

仍只有一个 MutationObserver 和原有的一个防抖 timer。没有新增 Map、轮询、单元状态副本或持久设置。运行时每个开放根会有观察目标、slotchange 监听和最多一条共享样式引用，这些浏览器内部实例数不由静态定义计数表达；重扫重新绑定，stop 解除监听，清除移除共享样式。JS 缓存不持有根引用，样式异步回调只在节点仍连接时采用结果。

当前请求或扫描期定义/直接字段仍为 20/6，记录结构/字段仍为 14/99，单元写入的文件×字段组合仍为 5。按模块统计相对下方历史表仅 observer 的绑定 2 → 3，以及新增 shadow-styles 的绑定 1、直接字段 2。

---

## v0.17.0 的历史口径与记录

这份清单覆盖 src 全部 JS 文件，列出跨作用域可变绑定、容器、观察器、计时器和记录字段。原先的 41/36 只覆盖 main、PageSession、Scheduler 的一部分，不能与下表混用。旧说明保存在 `STATE-v0.16.8.md`。

## 可复测基线

| 口径 | v0.16.8 | v0.17.0 |
| --- | ---: | ---: |
| 跨调用可变绑定/资源定义 | 100 | 100 |
| 上述对象展开的直接字段 | 49 | 48 |
| 请求、扫描期间的闭包变量/资源定义 | 20 | 20 |
| 上述临时对象直接字段 | 6 | 6 |
| 已识别记录结构 | 14 | 14 |
| 记录字段定义 | 99 | 99 |
| 单元写入的文件×字段组合 | 5 | 5 |

扫描脚本及 TRANSIENT 分类清单未改，100 → 100 是同口径结果。没有新增 owner、Map、计时器或存储配置。PageSession 继续独占 token 累计；UI 总计、翻译统计和覆盖信息由它与已有单元数据派生。

## 本轮状态的真实变化

`translationRuntime.usageIncomplete` 不再独立累计，由 PageSession 的翻译阶段读取，直接字段少一项。`tokens` 的三项直接字段从 input/output/cachedUnits 变成 translation/preflight/cachedUnits；每个阶段内部各有 input/output/incomplete 三个标量。

这意味着相关叶字段从旧 tokens 三项加 runtime 的 incomplete 一项，共四项，增加到新 tokens 的七项，净增三个标量。静态清单只展开一层，没有显示这些嵌套叶字段，所以不能把 49 → 48 当成总状态减少。

两个阶段的用量不能从原有合计逆推出，因此需要分别保存；合计始终派生。`requestReasons` 存在当前请求的 runtime 对象里，不新增页面容器；单批最多九次实际发送，键来自内部原因分类。日志仍只在现有的环形容器中保留这些结果。

这份静态脚本也不会展开调用参数别名下的全部字段、闭包内只读投影、Chrome 存储条目，或运行时的对象实例数。新增这些结构时必须人工复核。预检 v2 沿用原缓存存储，并把所有预检命名空间统一限制为最多 128 条，未新建 Map。

## 范围与限制

- 检查模块级写入和被闭包引用的可变局部变量，包括 const Map/WeakMap、观察器与计时器；只读常量不计作活动状态。
- 展开可静态识别的直接字段和指定记录结构；不递归计算嵌套字段。
- DOM 引用和扩展直接修改的属性纳入清单，不展开浏览器内部 DOM 树。
- 请求/扫描作用域分类经过人工列举；不得通过修改分类降低数字。
- 关闭先例时，工厂定义仍列在静态清单里，运行时不创建先例容器。
- 100 不包含 storage.session 最多 240 条事件的所有实例和字段；临时日志仍受环形上限及浏览器会话生命周期约束。
- 此清单不是安全证明，不能替代取消、失联、过期提交和缓存行为测试。

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
| src/content/main.js | 12 | 27 | 6 |
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

`npm run audit:state` 输出当前明细；`node test/state-inventory.test.mjs` 检查新绑定、字段或生命周期变化是否已登记。v0.17.0 的基线文件为 `state-baseline-v0.17.0.json`；当前使用顶部所列的 v0.17.4 基线，旧 JSON 均保留。更新基线时，应说明谁写入、保留多久、为何不能从已有数据派生；动态键和嵌套结构需要额外说明。
