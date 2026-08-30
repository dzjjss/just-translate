# Changelog

## 16.0 — 2026-08-30

新增独立的免 Key 基础翻译路径。它复用 Just Translate 的 DOM 提取、整页调度、缓存和双语渲染，但不把机器翻译包装成 LLM。

### Google Translate 与 DeepLX

- 新增「免 Key · Google Translate（实验）」：直接调用非官方网页端接口，固定服务地址，不要求 Key 或模型名。
- 新增「免 Key · DeepLX 自托管（实验）」：填写完整 POST 地址，默认使用本机 `http://localhost:1188/translate`；不捆绑不可控的公共中转。
- 目标语言在后台映射为 Google / DeepLX 语言码；不认识的名称会明确报错，不静默猜测。
- 设置面板改称「翻译引擎」。免 Key 模式隐藏 Key、模型、页面规则、自动预检、语义一致性观测与跨批先例，并明确提示正文的实际发送方。

### 机器翻译也获得文档上下文

- 安全范围内（`≤4,500` 源字符且 `≤60` 单元）把正文合并成一个请求，以获得跨段一致性并减少重复请求；用户仍可关闭整页模式。
- 超限分块时附带可丢弃的标题、章节路径和前后原文。上下文只帮助机器翻译，不会渲染到页面。
- 合并文本使用纯传输边界恢复原 DOM ID，不借大小写或格式判断词义。任一边界损坏会丢弃整批结果并二分重试；单条最终退回裸文本，避免串段和标记残片进入译文。
- 服务端若因长度返回 400 / 413 / 414，同样自动二分；机器翻译缓存绑定完整批次与上下文，不复用脱离批次的单句结果。
- runtime telemetry 新增 `boundaryRecoveryCount` 与 `machineContextChars`，并继续记录请求数、分拆次数、整页模式与缓存命中。

### 工程基线

- 新增 Google / DeepLX wire、语言码、边界恢复、邻接语境与 popup 能力降级回归；全量 lint 与测试覆盖两类引擎。
- 版本提升为 16.0；Google 网页接口不是稳定公开 API，DeepLX 中转也不等于本地或匿名，这些限制在 README 与 UI 中同时公开。

## 15.0 — 2026-08-30

这次直接收束到 15.0：把已经验证有效的整页翻译从手动 Beta 升级为默认主路径，同时完成一轮克制的 UI 可读性升级。

### 整页优先成为默认调度策略

- 首轮正文在 `≤12,000` 源字符且 `≤80` 个单元时一次提交全文；任一项超限自动进入分块路径。
- 用户可以关闭「优先整页翻译」，强制始终分块。设置旁明确说明不同模型的上下文与最大输出限制不同，分块无法彻底避免。
- 后续动态节点不冒充全文，继续按分块路径增量处理；整页 prompt 新增文档级语体/称谓决策，并继续禁止跨义项强行统一。
- runtime telemetry 新增翻译模式、触发原因、源字符数、单元数、真实请求数、漏项分拆请求数和整页缓存命中字段。

### 整页缓存不再浪费重复访问

- 整页缓存绑定完整有序页面快照与单元位置，重复句不会因为裸句 key 而串用上下文译法。
- 只有全页 100% 命中才直接返回；部分命中一律忽略并重新发送全文，完整成功后才写入整页结果。
- 分块模式继续使用原有逐段缓存；整页与分块仍有独立 prompt fingerprint。

### UI 与迁移

- popup 基础字号、说明文字、输入框、设置 Tab、按钮与开关点击面积整体上调，继续使用本机 UI 字体栈，不增加外部字体依赖。
- 译文在浅色/深色页面下分别使用单层亚像素浅边/暗边阴影；只绘制完成态文本，不使用会让中文细笔画变粗的 `text-stroke`，并在高对比与强制配色模式下自动关闭。
- 修复设置齿轮 SVG 几何中心与轮廓错误；改用固定 viewBox 的描边图标，避免系统缩放后畸形。
- API Key 旁新增「复制」按钮，显式点击时复制当前服务商的当前输入草稿；不要求先应用，也不会自动显示或记录 Key。
- 整页设置从旧 Beta 默认关闭迁移为带安全门槛的默认开启；settings schema 升到 v13，Prompt 结构版本升到 10。

### 规则与观测收束

- 预检重新明确 `优先` 与 `风险词` 的边界：需要稳定显示的 UI 标签/功能名进优先；只需选对义项、措辞可变的普通词进风险词。两者不得重叠，也不得靠大小写判断。
- 风险词义项说明明确不构成保留英文的理由；风险词上限收至 8。
- 人称代词缩写（如 `you'll / you're / we'll`）归入停用词，不再污染多义一致性候选。

## 0.14.11 — 2026-08-29

这一版收紧自动规则权限，并把“只观测”与“会改变译文”重新拆开。目标是修复自动预检留下英文原文的事故，同时删掉没有可靠语义判据的分类硬编码。

### 自动预检只保留软信息

- 预检输出契约收缩为 `领域 / 优先 / 风险词`；不再向模型索取页面原则或不翻列表。
- `softenAutoRules` 与正式翻译入口双重防御：旧模型、旧缓存或旧页面状态里的 `principle / keep` 一律清空，旧 `hard` 只降为 `preferred`。
- 用户规则不降权，人工写下的原则、锁定项和不翻项继续生效。
- 新增 `Adaptive Power` 回归，确认自动 `principle / hard / keep` 不会进入正式翻译 prompt。

### Taxonomy v3

- 语义分类收缩到有可靠判据的 `FIXED / STABLE / UNKNOWN`；`STRUCTURAL` 继续作为形式排除类。
- 删除 `sourceRoleShape` 与目标变体 containment 的语义判定作用。多个目标变体统一留在 `UNKNOWN`，不再自动宣布 `CONTEXTUAL / COMPOSITIONAL`。
- 保留旧汇总字段并固定为兼容统计，历史 telemetry 仍可横向比较；样本里的 `sourceRoleShape` 保留为 `null`。

### 观测与 precedent 分权

- `semanticConsistency` 改为纯观测开关，默认开启，不再进入 prompt 语义版本，也不再注入历史译法。
- 新增默认关闭的 **Beta：跨批先例注入**。只有开启它，exact local trigger memory 才会向后续批次提供先例。
- memory 新增 `precedentMatched / precedentDiverged / precedentUnaligned`，记录给过先例后的实际 alignment 是否一致；该统计只说明相关性，不声称先例造成了输出。
- settings schema 升到 v12；升级用户不会被静默开启新的行为实验。Prompt 结构版本升到 9，使旧缓存自然失效。

## 0.14.10 — 2026-08-29

新增默认关闭的 **Beta：整页单次翻译**，用于直接验证“分块造成的上下文压扁”能否通过一个简单、可量化的工程路径改善。

### 整页只发一次正式翻译请求

- 提取器与 DOM 渲染契约不变：正文仍按 unit 保留 id、边界和文档顺序，只在调度层把当前扫描到的全部 unit 一次取出。
- Beta 开启时绕过每批字符、20 条上限与视口优先；普通模式的分批、首批串行和后续并发路径完全保留。
- 正式翻译 prompt 明确告知模型这是完整页面扫描，可跨 item 判断指代、语体、实体和局部术语；同时禁止把不同义项强行统一。
- 后续动态出现的正文按新的扫描快照再发一次；模型漏回 id 时沿用已有的漏项二分补偿。

### 实验隔离

- 开关进入 RuntimeConfig 与 `semanticRevision`，切换后建立新 PageSession，旧请求不能写回新模式。
- 整页模式使用独立 prompt fingerprint，并绕过逐段缓存读写；否则 cache hit 会从全文 prompt 中挖掉上下文句，实验名义上整页、实际上只发未命中段。
- 开关旁明确标注这是 best-effort：模型的输入上下文、最大输出和超时限制各不相同，超长页面仍无法避免分批。
- 新增调度、内容脚本、prompt、设置迁移和 popup 回归：直接断言超出字符预算与 20 条限制时仍只有一个请求、24 条按原序进入且带整页标记。
- 版本更新为 0.14.10；Beta 对新装与升级用户都默认关闭。

## 0.14.9 — 2026-08-29

这一版只改设置生命周期，不碰 extractor、prompt、taxonomy 或 semantic memory。目标是取消“改一个小开关也要全局应用”的摩擦，同时保留模型凭证和长文本规则所需要的事务边界。

### 设置不再共用一个「应用」

- 删除 popup 顶部的全局应用栏。设置按生命周期分成 **LIVE** 与 **TRANSACTIONAL**：开关、选择器、外观和轻量性能参数直接保存；模型/API 与长文本规则各自在自己的配置块里显式应用。
- 显示方式、译文样式/颜色、四个自定义颜色、译文字体、悬浮球及位置即时生效；颜色/字体输入做轻量 debounce，避免拖取色器时每个像素都写 storage。
- 语义一致性保护、自动读取整页语境、正文优先、噪音过滤、缓存、debug、页面类型、并发和每批字符改动后直接保存；现有 RuntimeContract 继续决定当前页是纯重绘、调度更新、重扫还是新建 PageSession。
- 目标语言在输入确认（change/blur）时直接保存；跳过选择器在编辑完成离开输入框时保存，避免输入每个字符都触发页面重扫。
- 即时设置本身不再弹“保存成功”提示；控件状态就是反馈。

### 模型与规则保留事务边界

- Provider / API Base / API Key / Model 仍作为一个事务配置块，新增「应用模型设置」。切换服务商只切换本地 draft，不会在用户尚未确认时改掉当前 active provider。
- 未应用的不同服务商 draft 在当前 popup 会话内各自保留；真正应用时才一次性写回 `accounts` 与当前顶层三件套。
- 背景、精确规则、全局附加指令统一由「应用规则」提交；规则转换和“复制自动画像到页面规则”只产生 draft，不会偷偷生效。
- 点「翻译当前页面」会自动提交尚未应用的模型/规则 draft，主流程不要求用户先额外点两次应用；两个应用按钮用于“只保存、不立即翻译”。
- “测试连接 / 拉取模型 / 规则转换 / 临时翻译”可以使用当前模型 draft 做一次性调用，不需要为了测试先污染 active 配置。后台只接受这些 panel-only 消息里的白名单 override。

### 当前页同步

- LIVE 设置写入后，已注入的当前页会立即收到 RuntimeConfig；打开悬浮球时即使当前页还未注入，也会走现有 `SYNC_ON_TAB` 兜底把入口挂上。
- 站点已固定时，「本站自动翻译」开关即时更新对应 site rule；尚未固定时保持为待固定选项。
- 没有改变现有热更新语义：呈现项只重绘；提取项重扫；semanticRevision 变化建立新 PageSession，避免一轮翻译内部混用两套语义配置。

### 工程基线

- DOM 测试同步到当前权限契约：自动预检只有五档，不生成 hard；自动术语建议通过独立的 `preflightSuggestions` 通道进入翻译，不与正式 profile 混用。
- popup 测试按静态注入后的真实页面状态验证当前页同步，并更新页面规则入口和自动术语建议文案。
- ESLint 补齐浏览器原生 `navigator` 全局声明；`npm run check` 的 lint 与 176 条测试全部通过。

## 0.14.8 — 2026-08-28

这一版把 Beta 正式毕业为默认开启的 **语义一致性保护**，但不扩大自动统一权限。重点不是提高“解决率”，而是把格式噪声、预检随机性和真正的 occurrence 语义拆开，让后续 Concept Store / Translation Memory 能建立在可信数据上。

### 语义一致性保护正式化

- 原 Beta 开关改名为 **语义一致性保护**，fresh install 与升级用户默认开启；关闭时不再注入 session semantic memory，也不记录这套一致性 telemetry。
- 保留 v0.14.7 的 scoped semantic memory：普通词只按 `lemma + exact local trigger` 复用先例，绝不恢复裸词 `word -> canonical translation`。
- memory 增加 provenance / runtime 统计，导出数据可看到 hint lookup、命中、冲突熔断和可用 contextual entry 数，便于区分“模型自己翻对”与“历史先例实际参与”。
- 正式功能不再为了 telemetry 全局绕过缓存；需要严格 A/B 时可用现有“重翻”绕过缓存。

### 格式不再替语义做决定

- 删除普通 `ALL CAPS -> FIXED` 推断。`BOOK / COMMON / SAW / FRIDAY / VIII` 这类小说标题词和罗马数字只形成 `STRUCTURAL` 观测，从术语 drift 指标中排除。
- `iPhone / iPadOS / Wi-Fi` 等内部大小写或混合结构仍可作为高置信 identifier 证据；单纯 `LTE / HTTP / API` 之类全大写缩写不再仅凭格式获得 FIXED 权限。
- 同一 lemma 若在正文出现正常大小写形态，正文 lexical 身份压过标题 structural 形态，避免 `COMMON` 标题污染正文 `common`。
- taxonomy 增加 `STRUCTURAL` 与 `CONTEXTUAL`。`Martian -> 火星人 / 火星` 这类名词位/定语位变化先记为语境相关，而不是 confirmed drift。

### 目标变体归一化与更保守的 COMPOSITIONAL

- 一致性比较前做 deterministic normalization：NFKC、空白归一化、剥掉首尾成对的中英文引号/书名号；同时保留 `renderedRaw`，页面真实排版完全不改。`设置 / “设置”`、`洞察 / “洞察”` 不再制造假 drift。
- `TARGET_VARIANT_CONTAINMENT` 只保留为 evidence，不再单独确认 COMPOSITIONAL。只有 source 与 target 两侧都存在对应包含证据时才确认组合变化，避免把 `火星 / 火星人` 这种语法实现误判为 COMPOSITIONAL。

### Preflight 降权与可重复 A/B

- 自动预检不再生成/保有 hard rule 权限；历史 `hard` 输出进入翻译前也会降级为 `preferred` suggestion。用户明确写下的 hard rule 仍是 ENFORCED。
- 自动术语建议与用户 `preferred/hard` 分成独立 prompt block，明确标为未验证软提示；当前语境或语法角色不一致时模型应忽略。
- trust 统一为 `OBSERVED / SUGGESTED / AUTO / ENFORCED`，避免“一次模型预检”直接获得硬控制权。
- 同一 URL 默认复用 preflight snapshot，并记录 hash / createdAt / reused / profile；只有显式“重新读取”才刷新。切模型、重翻或开关语义一致性保护时可以保持同一预检基线。

### Telemetry 与测试

- 总对齐率之外新增 `semanticAlignmentRate` 和按 kind 拆分的 alignment 统计；结构化标题不再把小说 coverage 人为抬高。
- 新增小说回归：ALL CAPS 标题与罗马数字不得成为 FIXED、正文大小写应覆盖标题格式、`Martian` 语法变化不得报 locked drift。
- 新增引号归一化、双边 COMPOSITIONAL 证据、preflight 降权/风险词冲突、snapshot 复用、memory provenance 等回归。

## 0.14.7 — 2026-08-28

这一版把跨 chunk 约束从“裸词统一”改成有作用域的 session semantic memory，同时完成下一轮默认模型、Prompt 数据格式和 Sunset Orange 视觉更新。

### Session semantic memory

- 新增 session 级 contextual memory；普通词的 key 不再是 `word -> translation`，而是 `lemma + exact local trigger -> prior rendering`。`battery power → 电量` 与 `Power Mode → 电源` 天然分开，不能互相污染。
- 局部 trigger 取 occurrence 左右的源词窗口并做规范化；只有后续 chunk 再次精确命中同一个 trigger 时才注入先例。没有 exact match 就不使用历史。
- 同一 trigger 一旦观测到两个目标变体立即熔断，不做 first-wins canonical。FIXED/locked 继续由已有 hard/profile 约束处理，不让普通 lexical memory 越权。
- semantic memory 复用同一次翻译响应里的可选 `a` alignment 元数据，不增加额外模型请求；Beta 仍只负责 telemetry 展示与缓存隔离，不决定 memory 是否存在。
- memory hint 会进入该批 cache fingerprint，避免不同 scoped precedent 仍命中同一旧缓存。

### YAML 输入 / JSON 输出

- 页面元数据、items、预检 digest、自然语言规则转换输入改为稳定 YAML 子集；字符串统一使用 JSON 双引号转义，因此无需增加 YAML 依赖。
- 翻译返回合同仍严格是单个 JSON object；解析链路不改。
- Prompt 结构版本升到 7，使旧缓存自然失效。

### 默认模型与视觉

- fresh install 默认服务商改为 DeepSeek 官方：`https://api.deepseek.com` / `deepseek-v4-flash`。升级迁移明确不修改已有用户 provider/model。
- 品牌与页面内 UI 改为 Sunset Orange：主强调色 `#F2783C`；译文默认使用耐读的 Sunset Ink（浅色 `#9A4F2D` / 深色 `#F2A06B`），不是整篇高饱和橙。
- settings schema 升到 v9：只有仍保持 0.14.6 旧默认紫色/继承字色的用户会自动迁移；自定义过主题的人不覆盖。

### 测试

- 新增 semantic memory 回归：`battery power` 与 `Power Mode` 必须隔离、exact trigger 才复用、同 trigger 多译必须熔断。
- 新增 YAML 输入 / JSON 输出合同、memory cache fingerprint、DeepSeek fresh default 与主题迁移保护测试。

## 0.14.6 — 2026-08-28

这一版只做 UI / 信息架构升级，不改翻译、提取、缓存、Beta telemetry 或 prompt。目标是把 popup 从“不断加折叠项的设置页”改成真正的翻译操作台，并统一品牌视觉。

### 两层信息架构

- 首页只保留三件高频内容：**当前页面翻译、页面语境、Beta 词汇观测**。模型、外观、页面规则和高级参数不再和日常操作混排。
- 设置改成独立视图，并用一级 Tab 分成 `模型 / 外观 / 页面规则 / 高级`；移除原来的 `工具与高级 → 临时翻译 / 提取与性能 / 维护与导出` 套娃折叠。任何配置最多两步可达。
- 首次未配置时直接进入“模型”页；配置完成后默认回到翻译首页。页面语境里的“调整页面规则”会直接切到对应 Tab。
- Beta 保持首页一级入口，不随设置迁移回深层。

### 交互与视觉

- 显示方式从下拉框改成 `双语 / 译文 / 原文` 三段式切换，高频状态不再藏进 select。底层仍保留同一个 `displayMode` 设置键，不改变运行合同。
- 统一使用现有紫色 `#5A4FE0` 作为品牌、主动作和选中态；普通结构主要依靠留白、分隔线和中性色，减少 card soup。
- 圆角收敛到 8 / 12 / 16 三档，间距按 4px 基准整理；checkbox 统一为 switch；API / selector / model 等机器输入继续使用等宽字体。
- 页头不再使用单独的“译”字图标，直接复用扩展正式 icon；页面悬浮球也换成同一品牌 glyph，并从圆形改为圆角方形，popup 与网页内 UI 使用同一视觉语言。
- “未应用修改”改成只在 dirty 时出现的轻量提示条，避免稳定状态长期占据主任务空间。

### 测试

- 更新架构测试，固定 Beta 必须位于首页、设置必须是一级 Tab，不允许重新退化成多层 `details.fold`。
- 核心纯逻辑测试 54 条全部通过，并对 popup / 悬浮球相关 JS 做 `node --check`。当前环境仍缺少 jsdom，因此完整 popup DOM 套件未执行。

## 0.14.5 — 2026-08-28

这一版只修 Beta 的候选发现与观测 taxonomy，不增加消歧请求、不自动统一译文。0.14.4 暴露出的根问题是：把“首字母大写”同时当成专名证据和低歧义证据，导致技术文档里的 Learn / Open / Use / Ongoing 等句首或标题词被错误归类。

### Beta：按处理方式分类，不再按“大写/普通词”二分

- taxonomy 改为 `FIXED / STABLE / COMPOSITIONAL / POLYSEMOUS / STYLISTIC / UNKNOWN`。本版只有硬证据才会自动进入 FIXED / STABLE / COMPOSITIONAL；`POLYSEMOUS` 与 `STYLISTIC` 预留给后续 occurrence-level / 多语料证据，不会靠格式猜。
- `FIXED` 只接受两类高置信来源：用户/画像已有的明确 `hard` 锁定，以及 `iPhone / iPadOS / iOS / Wi-Fi / LTE / HTTP` 这类内部大小写、缩写或结构化源形态。普通 Title Case 和句首大写不再晋升为 FIXED。
- `Ogilvy / Common / Ongoing / Learn / Open / tap` 等普通重复词统一走 lexical observation。即使看起来像人名，也不会因为首字母大写直接宣布“专名漂移”。
- lexical identity 按 lemma 聚合，但保留每次真实的 `sourceSurface` 和 `localContext`；`Common/common`、`Ongoing/ongoing` 的大小写差异不再被当作语义结论，而是作为 occurrence 证据保留下来。
- 每批发给模型的 tracked term 尽量采用该批真实出现的 surface，避免拿 `Ongoing` 去描述实际是 `ongoing` 的 occurrence。
- 普通实词最小长度从 6 降到 3，并扩充功能词 stop list；`tap` 这类技术文档高频短词终于能进入观测，不再因长度阈值直接漏掉。
- 目标变体存在明显包含关系时标为 `COMPOSITIONAL`（如 `了解 / 进一步了解`、`电 / 电池`），只作为“优先检查短语/组合翻译”的观测信号，不触发任何替换。
- 多个非包含型目标变体在没有更多语义证据时统一标 `UNKNOWN`；不会提前叫 `POLYSEMOUS`，也不会计入 drift。
- `FIXED` 多译才计 `fixedDrift`；旧的 `properNameDrift` 仅保留为兼容字段并固定为 0，主 UI 不再显示“专名漂移”。
- 原来的 coverage 改称“候选对齐率”，避免把候选池自身的召回质量误解成全页句对齐质量。

### Beta 入口前移

- Beta 从 `工具与高级 → 提取与性能` 移到 popup 主层级，位于当前任务卡之后；开关、摘要和“复制 Beta 数据”无需再钻多层菜单。
- 这只是入口搬迁，没有改设置键、session 行为或翻译链路；更大的 popup / Options 信息架构升级留到后续版本单独做。

### 测试

- 新增 Apple 风格回归：`Learn / Open / Check / Use / Charge / Enable / Low / Power / Mode / Usage / Ogilvy` 不能仅靠首字母大写成为 FIXED；`iPhone / iPadOS / iOS / Wi-Fi / LTE / HTTP` 仍能被高置信识别。
- 新增 `Ongoing/ongoing`、`Common/common` surface 保留、`tap` 短词召回、locked 覆盖自动候选、COMPOSITIONAL、FIXED drift、局部上下文留存等用例。
- 纯逻辑核心测试 53 条通过；本环境未安装 eslint/jsdom，因此 lint 与 DOM 套件仍无法执行，改为对全部 JS 做语法检查。

## 0.14.4 — 2026-08-28

把 0.14.3 的“自动统一译法”实验收回成纯观测 Beta。目标不是立刻修多义词，而是先把“真漂移”和“可能只是不同义项”分开统计，避免 canonical replacement 把一词多义误当成错误。

### Beta：多义词观测，不改译文

- `工具与高级 → 提取与性能` 的实验开关正式改名为 **Beta**，默认仍关闭；0.14.3 已保存的开关状态通过 settings schema v8 平滑迁移。
- 源文侧继续抽取跨段重复候选，并把明确 `hard` 规则单独标成 `locked`；不引入人工领域种子词表。
- 翻译响应里的可选 `a` 只作为 telemetry：记录某个源词这次实际落成的目标片段，页面侧不再做任何 canonical replacement。
- 普通词出现多个目标译法时标记为 `AMBIGUITY_UNKNOWN`，**不计入 drift，也不自动修正**；后续有真实数据后再决定是否值得增加 occurrence-level sense resolver。
- 专名多译单独记为 `PROPER_NAME_DRIFT`；明确锁定术语多译记为 `CONFIRMED_TERM_DRIFT`。三类指标分开，避免一致性统计被正常多义污染。
- Telemetry 同时记录 alignment coverage、目标变体计数和少量源/译文样本；popup 的 Beta 提示直接显示专名漂移、锁定术语漂移和“多义待判”数量，并提供“复制 Beta 数据”把完整 JSON 观测快照拷出来。
- `Common` 与 `common` 这类大小写语义不同的候选不再因 lowercase key 被合并；专名匹配保持大小写敏感。

### 实验隔离

- Beta 不删除原有 `LOCKED TERMS / PREFERRED TERMS`，因此不会像 0.14.3 那样顺带改变既有翻译约束。
- Beta 不进入 `semanticRevision` 或翻译缓存 fingerprint；它被单独归类为 observation change。
- 为拿到完整观测样本，Beta session 自动 bypass 译文缓存；Beta 产生的新译文也不写回基线缓存，避免观测 prompt 的轻微扰动污染正常缓存。
- 切换 Beta 会建立新 session，但这只是清理观测边界，不把它伪装成“翻译语义变化”。

### 测试

- 新增/改写纯逻辑用例覆盖：普通词多译只进入 `AMBIGUITY_UNKNOWN`、专名与 locked 术语分别计数、alignment coverage、`Common/common` 大小写隔离、Beta 不删除原有术语约束、Beta 不改变缓存 fingerprint、0.14.3 → Beta 设置迁移。

## 0.14.3 — 2026-08-28

新增一个默认关闭的 A/B 测试开关，只在手动开启时启用“源词对齐一致性”实验；基线翻译路径保持不变。

### 实验：源词对齐后统一译法

- `工具与高级 → 提取与性能` 新增“测试新一致性逻辑：源词对齐后统一译法”。默认关闭。
- 页面侧只从**源文**统计跨段重复候选：专名、专名短语、连字符词和较长重复实词；不再从译文表面重复反推术语。
- 每个翻译批次只携带本批实际命中的候选，最多 16 条；不会把整页词表反复塞进 prompt。
- 实验模式下不再把 `LOCKED TERMS / PREFERRED TERMS` 作为翻译 prompt 的固定译法约束；领域、义项风险词、保留项仍照常参与生成。
- 模型额外返回可选 `a` 对齐元数据：只报告“这个源词在本次译文中实际写成了哪一段”，不要求它为了术语表改写译文。
- 页面侧维护 session 级 canonical 表。第一次有效译法成为基准；后续出现不同译法时，依据 `a` 中的精确片段做本地查表替换。用户手写 hard 永远优先；自动预检 hard 只有同时命中“源文跨段重复候选”时才允许占据 canonical，避免单条误判污染全文。
- 实验模式暂时绕过译文缓存：旧缓存没有 alignment 元数据，混用会让 A/B 结果失真。
- 开启时才把实验标记计入 `semanticRevision` 与 prompt fingerprint；关闭时保持 v0.14.2 的基线身份，切换后仍会建立新页面 session，不把两套逻辑混在一次翻译里。

### 测试

- 新增纯本地用例覆盖：源文候选抽取、当前批命中筛选、首译建立 canonical、漂移替换、硬锁定优先、实验输出合同与 alignment 解析。

## 0.14.2 — 2026-08-28

这一版只修悬浮球启动与宿主定位，不改翻译、提取、调度或 prompt。

### 悬浮球不再等待 service worker

- content bootstrap 先用 shared `DEFAULT_SETTINGS` 立即挂载悬浮球，再异步读取后台 RuntimeConfig。
- `GET_CONFIG` 冷启动、失败或暂时无响应不再阻止悬浮球出现；后台真实配置回来后继续通过幂等 `syncFab()` 校正显示状态与位置。
- 新增集成测试：故意挂起 `GET_CONFIG`，仍要求悬浮球在后台回复前已经存在。

### Shadow host 改为零尺寸 static

- `#byom-fab` host 只负责 Shadow DOM 隔离与挂载，固定为零尺寸、`position: static`、`overflow: visible`。
- `position: fixed`、最大 z-index、预设位置和拖动后的 `top` 全部移到 shadow 内部 `.fab-shell`。
- 继续挂在 `documentElement`，保留规避 body transform 与 SPA 清空 body 的既有行为。

## 0.14.1 — 2026-08-28

以 0.14.0 为基线，废弃 0.15 分支。这一版只做回归修复、目录回归和版本号可见性，不改翻译主链。

### 修复

- popup 初始化调用了随 `always-on.js` 一并删除的 `refreshAlwaysOn()`，`init()` 每次都抛 `ReferenceError`，面板实际是坏的。删除该调用。

### 目录回归 0.8.x 结构

- `src/content/page-session.js` 改回 `session.js`。
- `src/shared/runtime-contract.js` 并回 `settings.js`。
- `src/background/cache-policy.js` 并回 `translator.js`。
- `src/shared/provider-catalog.js` 保持独立：并回 `providers/index.js` 会让 popup 反向依赖 background，违反 architecture 测试里的分层约束。
- `page-context.js` 与 `translation-scheduler.js` 保持独立：0.8.x 无对应文件，且各自有 core 测试覆盖，折回 main.js 会丢掉这部分测试。

### 版本号可见

- 面板页头标题后显示版本徽标，页面状态条右上角同步显示。
- 两处都读 `chrome.runtime.getManifest().version`，manifest 是唯一来源，不会出现多处手改后对不上。
- 新增用例锁定徽标存在且位于页头。

## 0.14.0 — 2026-08-28

这一版只整理 popup / 页面语境 UX，不改翻译主链。目标是把面板从“同权重设置列表”改成围绕实际使用流程的任务界面，同时取消正常画像状态的警告式表达。

### 任务优先的界面层级

- 主 CTA 从底部 footer 提到第一张「当前页面」卡片；目标语言、双语/仅译文和翻译按钮放在同一个决策区，打开面板先完成当前任务。
- 首次未配置时「模型与 API」自动提到主任务下面并展开；配置完成后退到「页面语境 / 显示与外观」之后，不再长期占第一视觉位。
- 「页面显示」改为「显示与外观」，只保留标记、颜色、字体和悬浮球等低频呈现偏好。
- 「手动校准」改为「页面规则」；它是可选的人工覆盖，不再暗示自动判断出了问题。
- 「临时翻译」、提取/性能、缓存、调试和导出统一降到「工具与高级」的二级 disclosure，不再各占一级入口。
- 主要靠字号、留白、位置和 progressive disclosure 建立层级；强调色只留给主任务、当前状态和真正异常。

### 页面语境不再“催校准”

- fallback / 通用页面 / 画像很短 / 没有额外术语都按正常状态显示，不再出现「识别依据不足，去校准」警告。
- 页面语境主视图只显示领域、页面原则和有价值的约束摘要；完整规则树默认折叠，需要时再展开。
- 「调整页面规则」始终作为普通次级动作存在，不以 warning 形式抢注意力。
- 空规则树文案改为「当前没有额外翻译约束」，明确普通页面不需要为了“画像完整”而凑规则。
- 用户可见文案统一从「画像 / 预检」收敛到「页面语境 / 读取语境」；内部 preflight 契约和缓存语义不变。

### 测试

- popup 集成测试改为机械检查新的用户流程：主任务位置、首次配置提升、配置后模型退位、读写分离、fallback 中性展示、低频工具降级。
- 翻译 scheduler、cache、PageSession、provider、preflight prompt 均未改动。

## 0.13.0 — 2026-08-28

修复悬浮球在新页面根本不出现的 P0。问题不在球体 CSS，而在入口依赖 `activeTab` / 动态常驻注册：默认 `floatButton: true` 并不能让 content script 自己出现在页面里。

- 普通 HTTP/HTTPS 页面改为 manifest 静态注入 `loader.js` + `content.css`；悬浮球默认开启时随页面自举，不再要求先点面板、翻译或预检。
- 删除 `alwaysOn` 双开关、动态 `registerContentScripts` 模块和对应 popup UI；settings schema 升到 v7 清理存量字段。
- 保留 `activeTab + scripting` 作为当前页兜底注入，避免扩展更新后已打开标签页必须手动刷新。
- 修复 `SAVE_FAB_OFFSET` / `SAVE_DISPLAY_MODE` 被误列为 `PANEL_ONLY`：content script 现在可以通过受限 handler 正常持久化拖动位置与显示模式。
- 新增架构守卫：manifest 必须静态注入悬浮入口；content 自己的两类偏好写回不得再被 panel-only 拦截；内容脚本集成测试直接断言 bootstrap 后悬浮球首次出现。
- BYO API 跨域权限仍保持 optional、按实际 API origin 授权；页面静态注入不把后台 API fetch 权限放大成全站。

## 0.12.0 — 2026-08-28

增强 Extractor 对 inline HTML fragmentation 的处理（参考 Read Frog 的思路）。提取器原有的 run 合并已覆盖 `<a>/<span>/<strong>/<em>` 等标准行内标签；这一版补上实测中仍在切碎句子的两处。

### 自定义元素按行内处理

- 标签名带连字符的自定义元素（`<relative-time>`、组件库徽章等）此前被按块级处理：句子被切成碎片，碎片再被单 token 过滤器静默丢弃 —— 拆句与丢字是连环的。
- 现在默认按浏览器语义视为行内，随 run 合并进完整句子；组件计算样式声明为块级时仍按块处理，内部含块级结构时沿用 Google 卡片同款守卫，不做合并。

### `<br>` 不再粘连句子

- `<br>` 的 textContent 为空，直接拼接会把两侧句子粘成一段；现在贡献一个空格，经 normalize 收敛。

### 边界不变

- 相邻独立 `<p>/<li>/heading` 仍各自成单元；scheduler / cache / preflight / session 语义未动，无跨批状态，不做 inline 译文回填（行内标记在译文中降为纯文本，属明确接受的取舍）。
- 单元文本变化使旧缓存条目自然 miss，无需迁移。
- 新增 4 条提取器用例与 1 条真实链路用例（DOM → Extractor → Session → Scheduler → `TRANSLATE_CHUNK` payload 断言完整句子）。

## 0.11.1 — 2026-08-28

完成 v0.11 Complexity Reset 的第三刀：懒加载从单元生命周期降级为调度优先级。

### 懒加载 → 视口优先

- 删除 `IntersectionObserver`、`deferred` 占位态、`elUnits` 登记索引与 `lazy` 设置项（settings schema 升到 v6，清理存量字段，不做兼容层）。
- 扫描一次建立整页 unit；调度器取批时现算"是否在视口附近"，近的整体优先、组内保持文档序。优先级是取批瞬间的一次几何读取，不是登记状态。
- 调度器从"一次全发"改为固定宽度工作池（页内并发 3）：每空出一个位子，取的都是此刻离用户最近的一批，滚动后的优先级自然生效。
- 行为退让（明确接受）：整页最终会全部翻完，视口只决定顺序，不再省下视口外的 token。

## 0.11.0 — 2026-08-28

这一版只做减法，不加新功能。目标是把前几轮为了修复动态术语与缓存耦合而累积的状态机删掉。

### 删除 learned glossary

- 删除 `PageSession.glossary`、跨批 glossary 上行/回传、模型响应里的 glossary 输出合同。
- 删除 `applyGlossaryGuard`、动态 `termContract` 合并与模型自学习术语来源标记。
- 翻译批次不再依赖上一批返回的隐藏状态；页面术语约束只来自预检画像 + 用户规则。
- 漂移检测保留，但只检查明确锁定的静态术语。
- 删除「同页术语保持一致」开关；设置 schema 升到 v5，并清理老用户存量字段。

### 缓存复杂度重置

- `cache-policy.js` 保留为薄策略层，只负责 key / lookup / store。
- 删除 glossary fingerprint、provenance alias、fixed-point 迭代与缓存条目的 `g` 字段。
- cache key 回到 `provider + endpoint + model + promptFingerprint + source text`。
- 缓存条目只保存译文与时间；旧条目的历史 `g` 字段被自然忽略。
- prompt contract 版本升到 6，让旧缓存自然失效。

### 保留不动

- PageSession / TranslationScheduler 的 SPA 与异步隔离继续保留。
- 懒加载暂不删除；下一步单独评估把它从“单元生命周期”降级成纯 scheduler priority。

## 0.10.0 — 2026-08-22

这一版不加大功能，重点是把 v0.9.3 已经开始互相牵连的状态边界固定下来。

### 架构

- 新增 `shared/runtime-contract.js`：content 只拿页面真正需要的配置；模型、端点、自定义 prompt 等私有语义通过 opaque `semanticRevision` 表达。
- 新增 `content/page-session.js`：一页一个 PageSession。SPA、重翻、语义配置变化都会创建新 session，旧异步任务不能写进新页。
- 新增 `content/translation-scheduler.js`：`pending / inflight / firstBatchDone / drain` 由一个 owner 管理，第一批闸门与 flush 互斥不再散落在 `main.js`。
- 新增 `content/page-context.js`：站点规则只生成不可变的 PageConfig，不再反写 runtime config。
- 新增 `background/cache-policy.js`：translator 不再自己拼缓存策略；精确契约 key 与同页 provenance 冷启动恢复集中在一个模块。
- Provider 元数据移到 `shared/provider-catalog.js`，popup 不再跨层 import background 网络实现。
- 新增 `test/architecture.test.mjs`，机械检查依赖方向、循环依赖和 Scheduler 状态所有权。

### 正确性

- 修复 SPA 旧 preflight gate 清掉新 gate。
- 修复旧 drain 在换页后继续修改新 session、甚至发送旧页面 chunks。
- 修复同一 session 多个 flush 争抢“第一批”。
- 修复旧请求 `finally` 污染新 session 的 inflight 状态。
- 修复 cache 冷启动无法从 `glossary={}` 找回术语 provenance。
- provenance alias 增加页面 scope，避免跨文章恢复动态多义词。
- cache fingerprint 纳入 glossary 开关与实际 sampling 行为；不同端点、模型、prompt、画像、目标语言继续隔离。
- 站点 `skipSelectors` 改为派生配置，避免重复叠加与离站残留。
- 无空格文字系统不再被当成单 token；Han / Kana / Hangul 等脚本继续分别判断。
- 摘要结构采样增加真正的字符硬上限，单个异常超长 DOM 节点也不能击穿预算。
- 运行中的语义配置变化统一创建新 PageSession，避免同页混用两个模型/端点/prompt。
- `START` 在已有 session 中不再重复 rescan。

### Provider

- Gemini 默认模型更新为 `gemini-3.7-flash`，移除已退役的 Gemini 2.0 Flash 系列候选。
- Gemini 3.6+ 兼容路径不发送旧 sampling 参数；该差异也进入缓存身份。

### 工程卫生

- 项目版本统一为 0.10.0，保留 lockfile 与 Node `>=22.22.2` 要求。
- CI 固定 Node 22.22.2，执行 lint + 全测试。
- README 改为描述新的所有权边界；后续历史变化放到本文件，不继续把 README 当变更日志。

### 下一步

- `main.js` 仍然偏大，但 Scheduler、PageSession、PageContext 已从中拿走真正有并发语义的状态。下一次结构整理优先考虑 PreflightController。
- `background/router.js` 仍用 handler 表 + `PANEL_ONLY` 权限表；后续可物理拆成 content/panel 两组入口，让权限错误更难写。
- popup 仍然是大控制器。等 runtime contract 与 router 边界稳定后再拆 UI store，不在本版同时改动。
