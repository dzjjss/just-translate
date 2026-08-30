import { DEFAULT_SETTINGS, PROMPT_VERSION } from './constants.js';
import { hashString } from './hash.js';

const KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return migrate({ ...DEFAULT_SETTINGS, ...(stored[KEY] || {}) });
}

/**
 * 迁移。
 *
 * 这里有个不修就会反复中招的陷阱：读取是 { ...DEFAULT_SETTINGS, ...stored }，
 * 任意设置一旦通过 patchSettings 持久化，当前整张配置都会写进 storage；
 * 之后我们再改 DEFAULT_SETTINGS 里的默认值，对已有用户可能完全无效 ——
 * 他们存着的旧值排在展开式后面，每次都赢。
 * autoPreflight 从 false 改成 true 就是这么失效的：新装的用户有预检，
 * 老用户一次都没跑过，而且没有任何迹象。
 *
 * 所以默认值的变更必须走版本号，一次性改写，而不是指望改常量。
 */
const SCHEMA_VERSION = 13;

/** 每一步只做一件事，且必须幂等 */
const STEPS = [
  // v1：扁平三件套落成当前服务商的账户
  (s) => {
    if (!s.accounts || typeof s.accounts !== 'object') s.accounts = {};
    if (!s.accounts[s.providerId] && (s.apiKey || s.model)) {
      s.accounts = {
        ...s.accounts,
        [s.providerId]: { apiBase: s.apiBase, apiKey: s.apiKey, model: s.model }
      };
    }
  },
  // v2：预检改为默认开启，老用户存着的 false 要跟着翻过来
  (s) => {
    s.autoPreflight = true;
  },
  // v3：三个跳过开关合并成 smartFilter；只要老用户关过其中任意一个就沿用"关"
  (s) => {
    const old = [s.skipSameScript, s.skipSingleToken, s.skipTightLayout];
    s.smartFilter = !old.some((v) => v === false);
    delete s.skipSameScript;
    delete s.skipSingleToken;
    delete s.skipTightLayout;
    delete s.temperature;
    delete s.maxItemsPerChunk;
  },
  // v4：Google 已退役 Gemini 2.0 Flash。只迁官方 Gemini endpoint 上的两个旧默认名；
  // 自定义网关即使复用了这些名字也不碰，避免替用户猜服务端能力。
  (s) => {
    const retired = new Set(['gemini-2.0-flash', 'gemini-2.0-flash-lite']);
    const official = (base) => String(base || '').includes('generativelanguage.googleapis.com');
    if (s.providerId === 'gemini' && official(s.apiBase) && retired.has(s.model)) {
      s.model = 'gemini-3.7-flash';
    }
    const account = s.accounts?.gemini;
    if (account && official(account.apiBase) && retired.has(account.model)) {
      s.accounts = {
        ...s.accounts,
        gemini: { ...account, model: 'gemini-3.7-flash' }
      };
    }
  },
  // v5：删除模型跨批自学习术语。页面一致性只由用户规则 + 预检画像承担。
  (s) => {
    delete s.useGlossary;
  },
  // v6：懒加载从生命周期降级成调度优先级，设置项随之消失。不做兼容层。
  (s) => {
    delete s.lazy;
  },
  // v7：悬浮球改为 manifest 静态内容脚本常驻，删除旧的动态 alwaysOn 双开关。
  (s) => {
    delete s.alwaysOn;
  },
  // v8：0.14.3 的实验开关改名为 Beta；保留用户当时的开关状态，但语义改为纯观测。
  (s) => {
    if ('experimentalAlignedTerms' in s) {
      s.betaConsistency = Boolean(s.experimentalAlignedTerms);
      delete s.experimentalAlignedTerms;
    }
  },
  // v9：视觉系统从旧紫色切到 Sunset Orange。只迁“仍等于旧默认值”的用户，
  // 自己改过字色/强调色的人一律保留。模型默认改 DeepSeek 只对 fresh install 生效，
  // 这里明确不迁 provider/model，避免静默覆盖既有账户。
  (s) => {
    const untouchedOldTheme =
      (s.translationColor == null || s.translationColor === 'inherit') &&
      (!s.textColorLight || s.textColorLight.toLowerCase() === '#1f1f2e') &&
      (!s.textColorDark || s.textColorDark.toLowerCase() === '#e8e8f4') &&
      (!s.accentColorLight || s.accentColorLight.toLowerCase() === '#5a4fe0') &&
      (!s.accentColorDark || s.accentColorDark.toLowerCase() === '#8a80ff');
    if (untouchedOldTheme) {
      s.translationColor = 'custom';
      s.textColorLight = '#9A4F2D';
      s.textColorDark = '#F2A06B';
      s.accentColorLight = '#F2783C';
      s.accentColorDark = '#F59A64';
    }
  },
  // v10：Beta 毕业为“语义一致性保护”。这是新的正式能力，不沿用旧 Beta 的开关状态；
  // 默认开启。旧字段删除，避免以后同时存在两套同义设置。
  (s) => {
    delete s.betaConsistency;
    s.semanticConsistency = true;
  },
  // v11：新增“整页单次翻译”Beta。实验能力不替升级用户开启。
  (s) => {
    s.wholePageTranslation = false;
  },
  // v12：把纯观测与会改变译文的 scoped precedent 拆开。新实验不替升级用户开启。
  (s) => {
    s.semanticPrecedent = false;
  },
  // v13：整页翻译从手动 Beta 升级为带安全门槛的默认调度策略。
  // 旧开关控制的是另一种“无条件整页”语义，因此不继承其 false。
  (s) => {
    s.wholePageTranslation = true;
  }
];

function migrate(s) {
  const from = Number(s.schemaVersion) || 0;
  for (let i = from; i < STEPS.length; i++) STEPS[i](s);
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

/** 迁移结果要落盘，否则每次读取都重跑，用户手动关掉的开关会被反复打开 */
export async function getSettingsAndPersistMigration() {
  const stored = await chrome.storage.local.get(KEY);
  const raw = { ...DEFAULT_SETTINGS, ...(stored[KEY] || {}) };
  const before = Number(raw.schemaVersion) || 0;
  const next = migrate(raw);
  if (before < SCHEMA_VERSION) await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * 切换服务商：先把当前三件套存回原来那家，再把目标那家读出来。
 * 目标没存过就返回 null，交给调用方填服务商默认值。
 */
export function switchAccount(settings, nextId, current) {
  const accounts = { ...(settings.accounts || {}) };
  if (settings.providerId) accounts[settings.providerId] = { ...current };
  return { accounts, next: accounts[nextId] || null };
}

export async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue || {}) });
  });
}

/**
 * provider 可选：本地服务（Ollama / LM Studio）没有 Key 的概念，
 * 逼用户填个假的 1234 才能用是纯粹的自找麻烦。
 */
export function isConfigured(s, provider) {
  const needKey = provider ? provider.requiresKey !== false : true;
  return Boolean(s.apiBase && s.model && s.targetLang && (!needKey || s.apiKey));
}

/**
 * Background -> content 的唯一运行时契约。
 *
 * content 只拿页面侧真正需要的字段；API Key / endpoint / model / customPrompt
 * 不下发页面。会改变翻译语义但页面不需要知道具体值的设置，被压成一个 opaque
 * semanticRevision。这样新增模型参数时不用再去 content 里补字段和分支。
 */
const EXPOSED_KEYS = Object.freeze([
  'targetLang',
  'presetId',
  'background',
  'rulesText',
  'maxCharsPerChunk',
  'wholePageTranslation',
  'minTextLength',
  'smartFilter',
  'skipSelectors',
  'contentRootOnly',
  'displayMode',
  'translationStyle',
  'translationFont',
  'translationColor',
  'textColorLight',
  'textColorDark',
  'accentColorLight',
  'accentColorDark',
  'autoPreflight',
  'semanticConsistency',
  'semanticPrecedent',
  'floatButton',
  'floatPosition',
  'floatOffset',
  'siteRules',
  'debug'
]);

/** 这些字段只在后台参与语义版本计算，不暴露给网页上下文。 */
const PRIVATE_SEMANTIC_KEYS = Object.freeze([
  'providerId',
  'apiBase',
  'model',
  'customPrompt'
]);

/** runtime config 里会改变“翻哪些内容”的字段。 */
const EXTRACTION = new Set(['minTextLength', 'smartFilter', 'skipSelectors', 'contentRootOnly', 'siteRules']);

/** 只改变分批方式；下一批自然生效。 */
const SCHEDULING = new Set(['maxCharsPerChunk']);

/** 纯观测开关：允许重建会话清空统计，但不应导致 prompt 版本变化。 */
const OBSERVATION = new Set(['semanticConsistency']);

/** 纯 UI 呈现。 */
const PRESENTATION = new Set([
  'displayMode', 'translationStyle', 'translationFont', 'translationColor',
  'textColorLight', 'textColorDark', 'accentColorLight', 'accentColorDark',
  'floatButton', 'floatPosition', 'floatOffset', 'debug'
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function semanticRevision(settings = {}) {
  const payload = {
    promptVersion: PROMPT_VERSION,
    exposed: {
      targetLang: settings.targetLang,
      presetId: settings.presetId,
      background: settings.background,
      rulesText: settings.rulesText,
      autoPreflight: settings.autoPreflight,
      semanticPrecedent: settings.semanticPrecedent,
      wholePageTranslation: settings.wholePageTranslation,
      // precedent 注入会改变 prompt，因此必须进入 semanticRevision；纯观测开关不进入。
      // siteRules 同时含语义字段和提取字段。只把真正改变 prompt 的部分算进
      // semanticRevision；单改 selectors 不需要整页重翻，交给 extraction 分支即可。
      siteRules: (settings.siteRules || []).map((rule) => ({
        host: rule?.host || '',
        presetId: rule?.presetId || '',
        background: rule?.background || '',
        rulesText: rule?.rulesText || ''
      }))
    },
    private: Object.fromEntries(PRIVATE_SEMANTIC_KEYS.map((key) => [key, settings[key]]))
  };
  return hashString(JSON.stringify(stable(payload)));
}

export function toRuntimeConfig(settings = {}) {
  const config = Object.fromEntries(EXPOSED_KEYS.map((key) => [key, settings[key]]));
  config.semanticRevision = semanticRevision(settings);
  return config;
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
    try {
      return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 对 runtime contract 做分类。semanticRevision 是最高优先级：它改变模型/指令/目标
 * 或预检契约，运行中的页面必须开新 session，不能只清半套状态。
 */
export function classifyRuntimeConfigChange(previous = {}, next = {}) {
  const out = { semantic: false, extraction: [], scheduling: [], observation: [], presentation: [], other: [] };
  if (
    previous?.semanticRevision !== next?.semanticRevision &&
    (previous?.semanticRevision || next?.semanticRevision)
  ) {
    out.semantic = true;
  }

  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])) {
    if (key === 'semanticRevision' || same(previous?.[key], next?.[key])) continue;
    if (EXTRACTION.has(key)) out.extraction.push(key);
    else if (SCHEDULING.has(key)) out.scheduling.push(key);
    else if (OBSERVATION.has(key)) out.observation.push(key);
    else if (PRESENTATION.has(key)) out.presentation.push(key);
    else out.other.push(key);
  }
  return out;
}
