import { LIMITS } from '../shared/constants.js';
import { log } from '../shared/logger.js';
import {
  buildMessages,
  buildPreflightMessages,
  buildRuleMessages,
  extractJsonObject,
  parsePreflightProfile,
  parseTranslationResponse
} from '../prompt/build.js';
import { normalizeRules, toYaml } from '../shared/rules-yaml.js';
import { getProvider, wireFor } from './providers/index.js';
import { Queue, withRetry } from './queue.js';
import { initCache, flush, cacheGeneration } from './cache.js';
import { preflightCacheKey, readPreflightCache, writePreflightCache, beginPreflightCache } from './preflight-cache.js';
import { createTranslationCachePolicy, machineBatchCacheItems, createLLMCachePlan, readLLMCache, writeLLMCache } from './translation-cache.js';
export { createTranslationCachePolicy, machineBatchCacheItems, canUsePerItemCache, wholePageCacheItems, lookupWholePageCache } from './translation-cache.js';
import { filterChatModels, parseModelList } from '../shared/provider-help.js';
import { hashString } from '../shared/hash.js';
import { resolveMachineTarget } from '../shared/machine-languages.js';
import { translateMachineWithRecovery } from './machine-translation.js';
import { isUsableTranslation } from '../shared/translation-result.js';
import { createExecution } from './execution.js';
export { isUsableTranslation } from '../shared/translation-result.js';
import { sessionSignal as signalFor } from './sessions.js';
export { abortSession, abortTab, openSession } from './sessions.js';


const queue = new Queue(3);

export function setConcurrency(n) {
  queue.setLimit(n);
}

/**
 * 处理一个 chunk。
 * items: [{ i, text }]
 * 返回 { items: [{i, t, cached}], failed: [i], usage }
 */
export async function translateChunk({ items, context, settings, sessionId, bypassCache = false }) {
  const signal = signalFor(sessionId);
  await initCache();
  signal.throwIfAborted();
  const provider = getProvider(settings.providerId);
  if (provider.kind === 'mt') {
    return translateMachineChunk({ items, context, settings, provider, sessionId, bypassCache });
  }
  const runtime = {
    translateRequestCount: 0, splitRetryCount: 0, wholePageCacheHit: false,
    invalidResponseSplitCount: 0, invalidResponseFailedUnits: 0
  };
  const plan = createLLMCachePlan(items, context, settings, provider);
  const cached = readLLMCache(plan, items, bypassCache, runtime);
  if (!cached.misses.length) return { items: cached.items, failed: [], usage: null, runtime };
  const execution = createExecution(signal, runtime);
  let translated;
  try {
    translated = await requestWithSplit({
      items: cached.misses, context: plan.context, settings,
      signal: execution.signal, execution, runtime, depth: 0
    });
  } catch (error) {
    error.runtime = { ...runtime };
    error.usage = execution.usage;
    error.usageIncomplete = execution.usageIncomplete;
    throw error;
  }
  const { items: fresh, failed } = translated;
  runtime.recoveredContext = runtime.splitRetryCount > 0;
  writeLLMCache(plan, items, fresh, failed, runtime.recoveredContext);
  return {
    items: [...cached.items, ...fresh.map(item => ({ i: item.i, t: item.t, a: item.a || null, cached: false }))],
    failed, usage: execution.usage,
    error: execution.failure || (runtime.sourceLimitFailedUnits ? { message: '部分原文超过单次请求硬上限', status: 0 } : null),
    usageIncomplete: execution.usageIncomplete, runtime
  };
}

async function translateMachineChunk({ items, context, settings, provider, sessionId, bypassCache }) {
  const wire = wireFor(provider);
  const targetLang = resolveMachineTarget(settings.targetLang, provider.id);
  const runtime = {
    translateRequestCount: 0,
    splitRetryCount: 0,
    wholePageCacheHit: false,
    boundaryRecoveryCount: 0,
    machineContextChars: 0
  };
  const fingerprint = hashString(JSON.stringify({
    engine: 'machine-translation:v1',
    providerId: provider.id,
    targetLang
  }));
  const cachePolicy = createTranslationCachePolicy({ settings, fingerprint });
  const virtualItems = machineBatchCacheItems(items, context);

  if (settings.useCache && !bypassCache) {
    const cached = cachePolicy.lookup(virtualItems);
    if (!cached.misses.length) {
      runtime.wholePageCacheHit = Boolean(context?.wholePage);
      runtime.recoveredContext = [...cached.hits.values()].some(item => item.contextScope === 'recovered');
      return {
        items: items.map((item) => ({ i: item.i, t: cached.hits.get(item.i).t, cached: true })),
        failed: [],
        usage: null,
        runtime
      };
    }
  }

  const signal = signalFor(sessionId);
  runtime.machineContextChars = String(context?.mtContext || '').length;
  const execution = createExecution(signal, runtime);
  const request = (text, depth = 0) =>
    queue.add(
      () =>
        withRetry(
          async (_attempt, retryError) => {
            if (text.length > LIMITS.MAX_REQUEST_SOURCE_CHARS) throw new Error('原文超过单次请求硬上限');
            execution.attempt(depth, depth ? 'boundary-or-length-recovery' : 'initial', retryError);
            const res = await wire.translate({
              base: settings.apiBase,
              text,
              targetLang,
              signal: AbortSignal.any([execution.signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)])
            });
            return res.text;
          },
          { signal: execution.signal, onRetry: (n, e, ms) => log(`机器翻译重试第 ${n} 次（${e.message}），${ms | 0}ms 后`) }
        ),
      execution.signal
    );

  let translated;
  try {
    translated = await translateMachineWithRecovery({
      items, context: String(context?.mtContext || ''), request,
      targetLang: settings.targetLang, runtime
    });
    signal.throwIfAborted();
  } catch (error) {
    error.runtime = runtime;
    error.usageIncomplete = execution.usageIncomplete;
    throw error;
  }
  runtime.recoveredContext = runtime.splitRetryCount > 0;

  const byId = new Map(translated.items.map((item) => [item.i, item]));
  if (settings.useCache && !translated.failed.length && translated.items.length === items.length) {
    for (const virtual of virtualItems) {
      const hit = byId.get(virtual.i);
      if (hit) cachePolicy.store(virtual.text, hit.t, runtime.splitRetryCount ? 'recovered' : 'batch');
    }
  }

  return {
    items: translated.items.map((item) => ({ i: item.i, t: item.t, cached: false })),
    failed: translated.failed,
    error: translated.error,
    usage: null,
    usageIncomplete: execution.usageIncomplete,
    runtime
  };
}

/**
 * 一次模型调用。模型漏条目通常是批太大导致的，所以把缺失的部分对半切开重试。
 * 两个 half 都要跑完再汇总失败清单 —— 早退会让后一半永远没机会。
 */
async function requestWithSplit(args) {
  const { items, settings, depth, execution } = args;
  if (execution.failure) return { items: [], failed: items.map(item => item.i) };
  let parsed;
  try { parsed = await requestTranslation(args); }
  catch (error) { return recoverInvalid(args, error); }
  const out = [];
  const missing = [];
  for (const item of items) {
    const text = parsed.map.get(item.i);
    if (isUsableTranslation(item.text, text, settings.targetLang)) {
      out.push({ i: item.i, t: text, a: parsed.alignments.get(item.i) || null, source: item.text });
    } else missing.push(item);
  }
  if (!missing.length || depth >= 2) return { items: out, failed: missing.map(item => item.i) };
  const recovered = await splitRequest({ ...args, items: missing, requestReason: 'missing-items' });
  return { items: [...out, ...recovered.items], failed: recovered.failed };
}

async function splitRequest(args) {
  const mid = Math.ceil(args.items.length / 2);
  const out = [];
  const failed = [];
  for (const items of [args.items.slice(0, mid), args.items.slice(mid)]) {
    if (!items.length) continue;
    const result = await requestWithSplit({ ...args, items, depth: args.depth + 1 });
    out.push(...result.items);
    failed.push(...result.failed);
  }
  return { items: out, failed };
}

async function recoverInvalid(args, error) {
  const { execution, items, depth, runtime } = args;
  if (execution.cancelled) throw error;
  if (!error.recoverBySplit) {
    execution.fail(error);
    return { items: [], failed: items.map(item => item.i) };
  }
  if (depth >= 2 || items.length <= 1) {
    const key = error.code === 'source-limit' ? 'sourceLimitFailedUnits' : 'invalidResponseFailedUnits';
    runtime[key] = (runtime[key] || 0) + items.length;
    return { items: [], failed: items.map(item => item.i) };
  }
  runtime.invalidResponseSplitCount++;
  return splitRequest({ ...args, invalidResponseRecovery: true,
    requestReason: error.code === 'source-limit' ? 'source-limit'
      : [400, 413].includes(error.status) ? 'context-length' : 'invalid-response' });
}

function translationMessages({ items, context, settings, depth }) {
  return buildMessages({
    items, context, presetId: context.presetId, targetLang: settings.targetLang,
    customPrompt: settings.customPrompt, background: context.background,
    profile: context.profile || null, preflightSuggestions: context.preflightSuggestions || {},
    trackedTerms: context.trackedTerms || [], semanticMemory: context.semanticMemory || [],
    wholePage: Boolean(context.wholePage && depth === 0)
  });
}

async function requestTranslation(args) {
  const { items, settings, signal, execution, depth, invalidResponseRecovery = false } = args;
  if (items.reduce((sum, item) => sum + item.text.length, 0) > LIMITS.MAX_REQUEST_SOURCE_CHARS) {
    throw Object.assign(new Error('原文超过单次请求硬上限'), { recoverBySplit: true, code: 'source-limit' });
  }
  const provider = getProvider(settings.providerId);
  const wire = wireFor(provider);
  const { system, user } = translationMessages(args);
  if (system.length + user.length > LIMITS.MAX_COMPILED_REQUEST_CHARS) throw new Error('Prompt 与原文超过请求硬上限，请缩短自定义规则');
  return queue.add(() => withRetry(async (_attempt, retryError) => {
    const response = await wire.complete({
      base: settings.apiBase, apiKey: settings.apiKey, model: settings.model, system, user,
      temperature: provider.omitTemperature ? undefined : LIMITS.TEMPERATURE,
      extraBody: provider.extraBody, auth: provider.auth, extraQuery: provider.extraQuery,
      extraHeaders: provider.extraHeaders,
      onAttempt: (reason = 'initial') => execution.attempt(depth,
        reason === 'initial' ? (args.requestReason || 'initial') : reason, retryError),
      onUsage: execution.observeUsage,
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)])
    });
    const parsed = parseTranslationResponse(response.text, items.map(item => item.i));
    if (!parsed.parsed) throw Object.assign(new Error('模型没有返回可解析的 JSON'), { retryable: true, recoverBySplit: true });
    return parsed;
  }, { retries: invalidResponseRecovery ? 0 : LIMITS.MAX_RETRIES, signal }), signal);
}


/** 翻译预检：整页摘要一次调用，产出文档画像 */
export async function runPreflight(args) {
  const signal = signalFor(args.sessionId);
  await initCache();
  signal.throwIfAborted();
  const key = args.settings.useCache ? preflightCacheKey(args) : null;
  const cached = !args.force && readPreflightCache(key);
  if (cached) return cached;
  const generation = cacheGeneration();
  const requestId = beginPreflightCache(key);
  const result = await requestPreflight(args);
  try {
    signal.throwIfAborted();
    writePreflightCache(key, result.profile, generation, requestId);
    // Persist before answering: a page refresh must not race the debounced write.
    await flush();
    signal.throwIfAborted();
  } catch (error) {
    Object.assign(error, { usage: result.usage, runtime: result.runtime, usageIncomplete: result.usageIncomplete });
    throw error;
  }
  return { ...result, reused: false, cacheSource: 'fresh' };
}

async function requestPreflight({ digest, context, settings, sessionId }) {
  const provider = getProvider(settings.providerId);
  if (provider.kind === 'mt') throw new Error('免 Key 基础翻译不支持页面预检');
  const wire = wireFor(provider);
  const runtime = { translateRequestCount: 0, splitRetryCount: 0 };
  const execution = createExecution(signalFor(sessionId), runtime);
  const signal = execution.signal;
  const { system, user } = buildPreflightMessages({
    digest,
    context,
    targetLang: settings.targetLang
  });
  try {
    const res = await queue.add(
      () =>
        withRetry(
          async (_attempt, retryError) => {
            const r = await wire.complete({
              onAttempt: (reason = 'initial') => execution.attempt(0, reason, retryError),
              onUsage: execution.observeUsage,
              responseFormat: 'text',
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
              const err = new Error('预检返回内容无法解析为有效规则');
              err.retryable = true;
              err.body = String(r.text).slice(0, 300);
              throw err;
            }
            log('预检画像 →\n' + toYaml(profile));
            return { profile };
          },
          { signal }
        ),
      signal
    );
    return { ...res, usage: execution.usage, usageIncomplete: execution.usageIncomplete, runtime };
  } catch (error) {
    error.usage = execution.usage;
    error.usageIncomplete = execution.usageIncomplete;
    error.runtime = runtime;
    throw error;
  }
}

/** 自然语言 → 结构化规则。返回可读文本，交给用户过目和手改。 */
export async function convertRules({ text, context, settings }) {
  const provider = getProvider(settings.providerId);
  if (provider.kind === 'mt') throw new Error('免 Key 基础翻译不支持把自然语言转换成规则');
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
  if (provider.kind === 'mt') return { ok: false, error: { message: '基础翻译引擎没有可选择的模型' } };
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
  if (provider.kind === 'mt') {
    const targetLang = resolveMachineTarget(settings.targetLang, provider.id);
    const res = await wire.translate({
      base: settings.apiBase,
      text: 'Hello',
      targetLang,
      signal: AbortSignal.timeout(30000)
    });
    return { ok: true, echoed: String(res.text).slice(0, 60) };
  }
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
