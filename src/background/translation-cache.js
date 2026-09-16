import { LIMITS } from '../shared/constants.js';
import { hashString } from '../shared/hash.js';
import { promptFingerprint, promptPageContext } from '../prompt/build.js';
import { cacheContextScope, cacheKey, getCached, putCached } from './cache.js';

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
      else hits.set(item.i, { t: translation, contextScope: cacheContextScope(keyFor(item.text)) });
    }
    return { hits, misses };
  }

  function store(source, translation, contextScope) {
    if (!settings.useCache) return;
    putCached(keyFor(source), translation, contextScope);
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

/** 机器翻译的译法受同批正文与邻接语境影响，因此缓存也必须绑定完整批次快照。 */
export function machineBatchCacheItems(items, context = {}) {
  const list = Array.isArray(items) ? items : [];
  const batchHash = hashString(JSON.stringify({
    texts: list.map((item) => String(item?.text || '')),
    context: String(context?.mtContext || ''),
    wholePage: Boolean(context?.wholePage)
  }));
  return list.map((item, index) => ({
    i: item.i,
    text: `machine-batch:v1:${batchHash}:${index}:${String(item.text || '')}`
  }));
}

/** 只有完整快照全命中才返回结果；partial hit 对调用方表现为一次普通 miss。 */
export function lookupWholePageCache(cachePolicy, items) {
  const cached = cachePolicy.lookup(wholePageCacheItems(items));
  if (cached.misses.length) return null;
  return items.map((item) => {
    const hit = cached.hits.get(item.i);
    return { i: item.i, t: hit.t, cached: true, ...(hit.contextScope ? { contextScope: hit.contextScope } : {}) };
  });
}

export function createLLMCachePlan(items, context, settings, provider) {
  const presetId = context.presetId || settings.presetId;
  const background = context.background ?? settings.background ?? '';
  const semanticFingerprint = promptFingerprint({
    presetId, customPrompt: settings.customPrompt, targetLang: settings.targetLang,
    background, profile: context.profile || null,
    preflightSuggestions: context.preflightSuggestions || {},
    semanticMemory: context.semanticMemory || [], wholePage: Boolean(context.wholePage),
    temperature: provider.omitTemperature ? null : LIMITS.TEMPERATURE
  });
  const fingerprint = hashString(JSON.stringify({
    semanticFingerprint,
    page: promptPageContext(context),
    texts: items.map(item => item.text)
  }));
  return {
    policy: createTranslationCachePolicy({ settings, fingerprint }),
    context: { ...context, presetId, background },
    perItem: canUsePerItemCache(settings, context),
    wholePage: Boolean(context.wholePage && settings.useCache)
  };
}

export function readLLMCache(plan, items, bypass, runtime) {
  if (bypass) return { items: [], misses: items };
  if (plan.wholePage) {
    const cached = lookupWholePageCache(plan.policy, items);
    if (!cached) return { items: [], misses: items };
    runtime.wholePageCacheHit = true;
    runtime.recoveredContext = cached.some(item => item.contextScope === 'recovered');
    return { items: cached, misses: [] };
  }
  const cached = plan.policy.lookup(items);
  return {
    items: items.filter(item => cached.hits.has(item.i)).map(item => ({
      i: item.i, t: cached.hits.get(item.i).t, cached: true
    })),
    misses: cached.misses
  };
}

export function writeLLMCache(plan, items, fresh, failed, recovered) {
  if (plan.perItem) {
    for (const item of fresh) plan.policy.store(item.source, item.t);
  }
  if (!plan.wholePage || failed.length || fresh.length !== items.length) return;
  const byId = new Map(fresh.map(item => [item.i, item]));
  for (const virtual of wholePageCacheItems(items)) {
    plan.policy.store(virtual.text, byId.get(virtual.i).t, recovered ? 'recovered' : 'whole-page');
  }
}
