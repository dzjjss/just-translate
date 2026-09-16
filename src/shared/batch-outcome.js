const COUNTERS = [
  'translateRequestCount', 'splitRetryCount', 'invalidResponseSplitCount',
  'invalidResponseFailedUnits', 'boundaryRecoveryCount', 'machineContextChars',
  'sourceLimitFailedUnits'
];

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function uniqueItems(entries, requested) {
  const items = new Map();
  const duplicated = new Set();
  for (const item of entries) {
    if (!item || !requested.has(item.i) || typeof item.t !== 'string' || !item.t.trim()) continue;
    if (items.has(item.i)) duplicated.add(item.i);
    items.set(item.i, item);
  }
  for (const id of duplicated) items.delete(id);
  return items;
}

function errorResult(error, valid) {
  if (!error) return valid ? null : { message: '后台未返回有效结果', status: 0 };
  return { message: String(error.message || error), status: finiteCount(error.status) };
}

/** Normalize once at the message boundary; missing usage stays unknown. */
export function normalizeBatchOutcome(raw, ids) {
  const value = raw || {};
  const valid = value.ok === true && Array.isArray(value.items);
  const requested = new Set(ids);
  const byId = uniqueItems(valid ? value.items : [], requested);
  const failed = new Set(Array.isArray(value.failed) ? value.failed.filter(id => requested.has(id)) : []);
  for (const id of ids) if (!byId.has(id)) failed.add(id);
  const counters = value.runtime || {};
  const runtime = Object.fromEntries(COUNTERS.map(key => [key, finiteCount(counters[key])]));
  runtime.wholePageCacheHit = Boolean(counters.wholePageCacheHit);
  runtime.recoveredContext = Boolean(counters.recoveredContext);
  runtime.usageIncomplete = Boolean(value.usageIncomplete ?? !valid);
  runtime.requestReasons = { ...counters.requestReasons };
  const error = errorResult(value.error, valid);
  return { ok: valid, code: value.code || '', items: [...byId.values()], failed: [...failed], runtime, usage: value.usage || null, error };
}

export function usageSummary(usage) {
  if (!usage) return { inputTokens: null, outputTokens: null };
  return { inputTokens: usage.input, outputTokens: usage.output };
}
