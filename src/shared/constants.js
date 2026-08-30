/**
 * 全局常量。任何跨上下文（popup / service worker / content）传递的字符串
 * 都必须在这里定义，不允许在业务代码里写字面量。
 */

export const MSG = Object.freeze({
  // popup -> background
  START_ON_TAB: 'start-on-tab',
  STOP_ON_TAB: 'stop-on-tab',
  PREFLIGHT_ON_TAB: 'preflight-on-tab',
  SYNC_ON_TAB: 'sync-on-tab',
  LIST_MODELS: 'list-models',
  GET_CONFIG: 'get-config',
  SAVE_FAB_OFFSET: 'save-fab-offset',
  SAVE_DISPLAY_MODE: 'save-display-mode',
  LAB_TRANSLATE: 'lab-translate',
  SET_LAB_SAMPLE: 'set-lab-sample',
  CONVERT_RULES: 'convert-rules',
  TOGGLE_ON_TAB: 'toggle-on-tab',
  QUERY_TAB: 'query-tab',
  TEST_CONNECTION: 'test-connection',
  CLEAR_CACHE: 'clear-cache',
  CACHE_STATS: 'cache-stats',

  // background -> content
  PING: 'ping',
  START: 'start',
  STOP: 'stop',
  TOGGLE_VISIBILITY: 'toggle-visibility',
  GET_STATE: 'get-state',
  CONFIG_CHANGED: 'config-changed',

  // content -> background
  TRANSLATE_CHUNK: 'translate-chunk',
  ABORT_SESSION: 'abort-session',
  HEARTBEAT: 'heartbeat',
  PREFLIGHT: 'preflight',

  // popup -> content（经 tabs.sendMessage 直达）
  RUN_PREFLIGHT: 'run-preflight',
  DIGEST_INFO: 'digest-info',
  EXPORT_MD: 'export-md',
  CLEAR_PAGE: 'clear-page',
  RESET_PROFILE: 'reset-profile',
  RESTART_PAGE: 'restart-page',

  // content -> popup（广播，无接收方时静默失败）
  TAB_STATE: 'tab-state'
});

/** 页面运行状态机 */
export const PHASE = Object.freeze({
  IDLE: 'idle',
  SCANNING: 'scanning',
  TRANSLATING: 'translating',
  DONE: 'done',
  PARTIAL: 'partial',
  ERROR: 'error'
});

/** prompt 结构版本号：改动 prompt 语义时 +1，用于让旧缓存自然失效 */
export const PROMPT_VERSION = 10;

export const DEFAULT_SETTINGS = Object.freeze({
  // 由 settings.js 的迁移步骤维护，改默认值时必须同步加一步
  schemaVersion: 0,
  // 顶层三件套 = 当前生效的账户。后台与内容脚本只认它，改动面小。
  providerId: 'deepseek',
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-flash',
  /**
   * 每家服务商各存一份 { apiBase, apiKey, model }。
   * 切换服务商时把当前三件套存回去、再把目标那份读出来 ——
   * 之前切一次 DeepSeek 的 Key 就被 OpenRouter 覆盖了，这是最影响日常使用的坑。
   */
  accounts: {},
  targetLang: '简体中文',
  presetId: 'auto',
  customPrompt: '',
  // 页面背景/主题：人工给定的语境边界，比自动识别可靠。进 prompt 的稳定段，
  // 所以每一批都要为它付费 —— 写长了成本会被放大 batch 倍。
  background: '',
  // 自然语言转出来的结构化规则（可读 YAML 子集）。用户可手改，优先级压过预检画像。
  rulesText: '',

  // 调度
  maxCharsPerChunk: 2800,
  concurrency: 3,
  // 优先整页：在保守的确定性阈值内把首轮正文一次性交给模型，超限自动分块。
  // 用户可以关闭，强制始终走分块路径。
  wholePageTranslation: true,

  // 提取
  minTextLength: 2,
  // 三个跳过规则合成一个开关：它们要解决的是同一件事 ——
  // 别把不该翻的东西送去翻。分成三个开关只是让人多做两次没意义的选择。
  smartFilter: true,
  skipSelectors: '',
  // 正文优先：只扫描探测到的正文根。关掉会退回全页扫描。
  contentRootOnly: true,

  // 呈现
  // 双语 / 仅译文 / 仅原文是偏好，不是"对已有译文的操作"：
  // 应该先选好再翻，而不是翻完才能调
  displayMode: 'bilingual', // bilingual | translation | original
  translationStyle: 'bar', // bar | underline | tint | plain
  translationFont: '', // 留空用内置中文字体栈
  translationColor: 'custom', // inherit | muted | accent | custom
  // Sunset Ink：长文正文不用高饱和橙，保留暖橙识别但降低视觉疲劳。
  textColorLight: '#9A4F2D',
  textColorDark: '#F2A06B',
  accentColorLight: '#F2783C',
  accentColorDark: '#F59A64',

  // 预检默认开：先通读整页拿到术语画像再翻，是这个项目质量的主要来源。
  // 让用户每次手动点，等于把最该默认发生的事挂在他记性上。
  autoPreflight: true,

  // 悬浮球默认开：它存在的意义就是不用打开面板，默认关掉等于自我否定
  floatButton: true,
  floatPosition: 'bottom', // bottom | middle | top
  floatOffset: 0, // 拖动后的垂直位置（视口百分比），0 表示用预设档位

  // 质量
  useCache: true,
  // 语义一致性观测：只记录跨 chunk occurrence / alignment / taxonomy，不修改译文。
  semanticConsistency: true,
  // Beta：仅在相同局部触发器下向后续批次注入先例。会改变 prompt，默认关闭。
  semanticPrecedent: false,

  // 站点覆盖：[{ host: 'arxiv.org', presetId: 'academic', background: '...' }]
  siteRules: [],

  debug: false
});

/** 语境判定来源，用于给用户明确反馈：认出来了，还是根本没认出来 */
export const PRESET_REASON = Object.freeze({
  'site-rule': '本站规则',
  manual: '手动指定',
  host: '域名匹配',
  structure: '页面结构',
  fallback: '默认兜底'
});

export const LIMITS = Object.freeze({
  // 翻译不需要发散，温度固定即可 —— 做成设置只是给人一个不知道该怎么调的旋钮
  TEMPERATURE: 0.2,
  // 每批条数与每批字符是同一件事的两种度量，留字符预算一个就够
  MAX_ITEMS_PER_CHUNK: 20,
  // 整页模式是质量优先的默认路径，但不同模型上下文与最大输出限制差异很大。
  // 这里只用保守、可解释的源文规模门槛；任一项超限就自动退回分块。
  WHOLE_PAGE_MAX_SOURCE_CHARS: 12000,
  WHOLE_PAGE_MAX_ITEMS: 80,
  // 页面侧同时在途的批数。整页排在页内队列里逐批取，视口附近的先走；
  // 全局请求上限仍由后台 concurrency 设置兜底。
  MAX_CONCURRENT_CHUNKS: 3,
  BACKGROUND_MAX_CHARS: 500,
  UI_TEXT_MAX_CHARS: 24,
  CACHE_MAX_ENTRIES: 4000,
  CACHE_FLUSH_MS: 3000,
  MAX_RETRIES: 2,
  REQUEST_TIMEOUT_MS: 90000
});
