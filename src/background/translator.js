import { LIMITS } from '../shared/constants.js';
import { log } from '../shared/logger.js';
import {
  buildMessages,
  buildPreflightMessages,
  buildRuleMessages,
  extractJsonObject,
  parsePreflightProfile,
  parseTranslationResponse,
  promptFingerprint
} from '../prompt/build.js';
import { normalizeRules, toYaml } from '../shared/rules-yaml.js';
import { getProvider, wireFor } from './providers/index.js';
import { Queue, withRetry } from './queue.js';
import { cacheKey, getCached, initCache, putCached } from './cache.js';
import { filterChatModels, parseModelList } from '../shared/provider-help.js';
import { hashString } from '../shared/hash.js';

/**
 * 翻译缓存的唯一策略层。
 *
 * 缓存只负责“相同翻译语义 + 相同原文 → 复用译文”。它不再参与术语生命周期，
 * 不恢复页面状态，也不做 alias / provenance / fixed-point。
 */
export function createTranslationCachePolicy({ settings, fingerprint }) {
  const keyFor = (text) =>
    cacheKey({
      providerId: settings.providerId,
      endpoint: settings.apiBase,
      model: settings.model,
      fingerprint,
      text
    });

  function lookup(items) {
    if (!settings.useCache) return { hits: new Map(), misses: [...items] };

    const hits = new Map();
    const misses = [];
    for (const item of items) {
      const translation = getCached(keyFor(item.text));
      if (translation == null) misses.push(item);
      else hits.set(item.i, { t: translation });
    }
    return { hits, misses };
  }

  function store(source, translation) {
    if (!settings.useCache) return;
    putCached(keyFor(source), translation);
  }

  return { lookup, store };
}

/** 整页上下文与逐条 cache hit 互斥：少任何一个 unit 都不再是同一个实验。 */
export function canUsePerItemCache(settings, context = {}) {
  return Boolean(settings?.useCache && !context?.wholePage);
}

/**
 * 整页缓存绑定“完整、有序的页面快照 + 当前单元位置”。
 * 同一句在不同位置可能因上下文得到不同译法，因此不能继续拿裸句子作整页缓存 key。
 */
export function wholePageCacheItems(items) {
  const list = Array.isArray(items) ? items : [];
  const pageHash = hashString(JSON.stringify(list.map((item) => String(item?.text || ''))));
  return list.map((item, index) => ({
    i: item.i,
    text: `whole-page:v1:${pageHash}:${index}:${String(item.text || '')}`
  }));
}

/** 只有完整快照全命中才返回结果；partial hit 对调用方表现为一次普通 miss。 */
export function lookupWholePageCache(cachePolicy, items) {
  const cached = cachePolicy.lookup(wholePageCacheItems(items));
  if (cached.misses.length) return null;
  return items.map((item) => ({ i: item.i, t: cached.hits.get(item.i).t, cached: true }));
}

const queue = new Queue(3);

/**
 * sessionId -> AbortController。
 * 一个 session 一个 signal，贯穿排队等待、退避 sleep、fetch、二分重试整条链路，
 * 所以点「停止」以后队列里还没发出的批次也不会再发出去。
 */
const sessions = new Map();

export function setConcurrency(n) {
  queue.setLimit(n);
}

function signalFor(sessionId) {
  let ctrl = sessions.get(sessionId);
  if (!ctrl) {
    ctrl = new AbortController();
    sessions.set(sessionId, ctrl);
  }
  return ctrl.signal;
}

/** 页面关掉或导航走了，这个 tab 名下所有 session 一律中止 */
export function abortTab(tabId) {
  let n = 0;
  for (const key of [...sessions.keys()]) {
    if (!key.startsWith(`${tabId}:`)) continue;
    sessions.get(key).abort();
    sessions.delete(key);
    n++;
  }
  return n;
}

export function abortSession(sessionId) {
  const ctrl = sessions.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  sessions.delete(sessionId);
  return true;
}

/**
 * 处理一个 chunk。
 * items: [{ i, text }]
 * 返回 { items: [{i, t, cached}], failed: [i], usage }
 */
export async function translateChunk({
  items,
  context,
  settings,
  sessionId,
  bypassCache = false
}) {
  await initCache();

  const presetId = context.presetId || settings.presetId;
  // 背景在页面侧解析（站点规则可覆盖全局），这里只认解析结果
  const background = context.background ?? settings.background ?? '';
  const profile = context.profile || null;
  const provider = getProvider(settings.providerId);
  const fingerprint = promptFingerprint({
    presetId,
    customPrompt: settings.customPrompt,
    targetLang: settings.targetLang,
    background,
    profile,
    preflightSuggestions: context.preflightSuggestions || {},
    semanticMemory: context.semanticMemory || [],
    wholePage: Boolean(context.wholePage),
    temperature: provider.omitTemperature ? null : LIMITS.TEMPERATURE
  });
  const cachePolicy = createTranslationCachePolicy({ settings, fingerprint });

  const results = [];
  let misses = [...items];
  const wholePage = Boolean(context.wholePage);
  const runtime = {
    translateRequestCount: 0,
    splitRetryCount: 0,
    wholePageCacheHit: false
  };

  // 分块模式继续使用逐段缓存。整页模式只接受完整页面快照 100% 命中：
  // 部分命中一律忽略并发送全文；完整成功后才写入这一页的全部单元。
  const allowCache = canUsePerItemCache(settings, context);
  const allowCacheStore = allowCache;

  if (allowCache && !bypassCache) {
    const cached = cachePolicy.lookup(items);
    misses = cached.misses;
    for (const item of items) {
      const hit = cached.hits.get(item.i);
      if (hit) results.push({ i: item.i, t: hit.t, cached: true });
    }
  } else if (wholePage && settings.useCache && !bypassCache) {
    const cachedItems = lookupWholePageCache(cachePolicy, items);
    if (cachedItems) {
      runtime.wholePageCacheHit = true;
      return {
        items: cachedItems,
        failed: [],
        usage: null,
        runtime
      };
    }
  }

  if (!misses.length) {
    return { items: results, failed: [], usage: null, runtime };
  }

  const signal = signalFor(sessionId);
  const usageAcc = { input: 0, output: 0 };
  const { items: fresh, failed } = await requestWithSplit({
    items: misses,
    context: { ...context, presetId, background },
    settings,
    signal,
    usageAcc,
    runtime,
    depth: 0
  });

  const freshById = new Map(fresh.map((item) => [item.i, item]));
  for (const r of fresh) {
    if (allowCacheStore) cachePolicy.store(r.source, r.t);
    results.push({ i: r.i, t: r.t, a: r.a || null, cached: false });
  }

  if (wholePage && settings.useCache && !failed.length && fresh.length === items.length) {
    for (const virtual of wholePageCacheItems(items)) {
      const translated = freshById.get(virtual.i);
      if (translated) cachePolicy.store(virtual.text, translated.t);
    }
  }

  return {
    items: results,
    failed,
    usage: usageAcc.input || usageAcc.output ? usageAcc : null,
    runtime
  };
}

/** 各家 usage 字段名不同，压成统一形状 */
function normalizeUsage(u) {
  if (!u) return null;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? 0
  };
}

/**
 * 一次模型调用。模型漏条目通常是批太大导致的，所以把缺失的部分对半切开重试。
 * 两个 half 都要跑完再汇总失败清单 —— 早退会让后一半永远没机会。
 */
async function requestWithSplit({ items, context, settings, signal, usageAcc, runtime, depth }) {
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  const ids = items.map((it) => it.i);

  const { system, user } = buildMessages({
    items: items.map((it) => ({ i: it.i, text: it.text })),
    context,
    presetId: context.presetId,
    targetLang: settings.targetLang,
    customPrompt: settings.customPrompt,
    background: context.background,
    profile: context.profile || null,
    preflightSuggestions: context.preflightSuggestions || {},
    trackedTerms: context.trackedTerms || [],
    semanticMemory: context.semanticMemory || [],
    // 只有第一次完整请求能声称“看到了整页”；漏项后的二分补偿是普通局部批次。
    wholePage: Boolean(context.wholePage && depth === 0)
  });

  log('system prompt →\n' + system);

  // 调用与解析放在同一个重试单元里：返回空内容或不可解析的 JSON 都值得再试一次
  const parsed = await queue.add(
    () =>
      withRetry(
        async () => {
          if (runtime) {
            runtime.translateRequestCount++;
            if (depth > 0) runtime.splitRetryCount++;
          }
          const res = await wire.complete({
            base: settings.apiBase,
            apiKey: settings.apiKey,
            model: settings.model,
            system,
            user,
            temperature: provider.omitTemperature ? undefined : LIMITS.TEMPERATURE,
            extraBody: provider.extraBody,
            auth: provider.auth,
            extraQuery: provider.extraQuery,
            extraHeaders: provider.extraHeaders,
            signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)])
          });
          const nu = normalizeUsage(res.usage);
          if (nu && usageAcc) {
            usageAcc.input += nu.input;
            usageAcc.output += nu.output;
          }
          const out = parseTranslationResponse(res.text, ids);
          if (!out.parsed) {
            const err = new Error('模型没有返回可解析的 JSON');
            err.retryable = true;
            err.body = String(res.text).slice(0, 200);
            throw err;
          }
          return out;
        },
        { signal, onRetry: (n, e, ms) => log(`重试第 ${n} 次（${e.message}），${ms | 0}ms 后`) }
      ),
    signal
  );

  const out = [];
  for (const it of items) {
    const t = parsed.map.get(it.i);
    if (typeof t === 'string' && t.trim()) {
      out.push({ i: it.i, t, a: parsed.alignments?.get(it.i) || null, source: it.text });
    }
  }

  const missing = items.filter((it) => parsed.missing.includes(it.i));
  if (!missing.length) return { items: out, failed: [] };

  if (depth >= 2 || missing.length <= 1) {
    return { items: out, failed: missing.map((it) => it.i) };
  }

  const mid = Math.ceil(missing.length / 2);
  const failed = [];
  for (const half of [missing.slice(0, mid), missing.slice(mid)]) {
    if (!half.length) continue;
    const sub = await requestWithSplit({
      items: half,
      context,
      settings,
      signal,
      usageAcc,
      runtime,
      depth: depth + 1
    });
    out.push(...sub.items);
    failed.push(...sub.failed);
  }
  return { items: out, failed };
}

/** 翻译预检：整页摘要一次调用，产出文档画像 */
export async function runPreflight({ digest, context, settings, sessionId }) {
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  const signal = signalFor(sessionId);
  const { system, user } = buildPreflightMessages({
    digest,
    context,
    targetLang: settings.targetLang
  });
  const res = await queue.add(
    () =>
      withRetry(
        async () => {
          const r = await wire.complete({
            base: settings.apiBase,
            apiKey: settings.apiKey,
            model: settings.model,
            system,
            user,
            temperature: provider.omitTemperature ? undefined : 0,
            extraBody: provider.extraBody,
            auth: provider.auth,
            extraQuery: provider.extraQuery,
            extraHeaders: provider.extraHeaders,
            signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)])
          });
          const profile = parsePreflightProfile(r.text);
          if (!profile) {
            // 解析不出、或者解析出来是空的，都不算成功 ——
            // 谎报成功会让面板显示"已生成画像"却什么都没有
            const err = new Error('预检没有得出任何规则');
            err.retryable = true;
            err.body = String(r.text).slice(0, 300);
            throw err;
          }
          log('预检画像 →\n' + toYaml(profile));
          return { profile, usage: normalizeUsage(r.usage) };
        },
        { signal }
      ),
    signal
  );
  return res;
}

/** 自然语言 → 结构化规则。返回可读文本，交给用户过目和手改。 */
export async function convertRules({ text, context, settings }) {
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  const { system, user } = buildRuleMessages({ text, context, targetLang: settings.targetLang });
  const res = await wire.complete({
    base: settings.apiBase,
    apiKey: settings.apiKey,
    model: settings.model,
    system,
    user,
    temperature: provider.omitTemperature ? undefined : 0,
    extraBody: provider.extraBody,
    auth: provider.auth,
    extraQuery: provider.extraQuery,
    extraHeaders: provider.extraHeaders,
    signal: AbortSignal.timeout(45000)
  });
  const obj = extractJsonObject(res.text);
  if (!obj) {
    const err = new Error('模型没有返回可解析的规则');
    err.body = String(res.text).slice(0, 200);
    throw err;
  }
  const rules = normalizeRules(obj);
  return { rules, yaml: toYaml(rules) };
}

/** 拉取服务商的模型清单，省得用户去翻文档抄模型名 */
export async function fetchModels(settings) {
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  if (typeof wire.listModels !== 'function') {
    return { ok: false, error: { message: '这个接口协议不支持列出模型' } };
  }
  const data = await wire.listModels({
    base: settings.apiBase,
    apiKey: settings.apiKey,
    auth: provider.auth,
    extraQuery: provider.extraQuery,
    extraHeaders: provider.extraHeaders,
    signal: AbortSignal.timeout(20000)
  });
  return { ok: true, ids: filterChatModels(parseModelList(data)) };
}

/** popup 的「测试连接」：最小成本验证 base / key / model 三件套 */
export async function testConnection(settings) {
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  const res = await wire.complete({
    base: settings.apiBase,
    apiKey: settings.apiKey,
    model: settings.model,
    system: 'Reply with exactly this JSON and nothing else: {"items":[{"i":1,"t":"ok"}]}',
    user: '{"items":[{"i":1,"t":"ok"}]}',
    temperature: provider.omitTemperature ? undefined : 0,
    extraBody: provider.extraBody,
    auth: provider.auth,
    extraQuery: provider.extraQuery,
    extraHeaders: provider.extraHeaders,
    signal: AbortSignal.timeout(30000)
  });
  const { map } = parseTranslationResponse(res.text, [1]);
  return { ok: true, echoed: map.get(1) || String(res.text).slice(0, 60) };
}
