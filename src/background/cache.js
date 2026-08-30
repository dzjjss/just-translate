import { LIMITS } from '../shared/constants.js';
import { hashString } from '../shared/hash.js';

const STORE_KEY = 'cache';

/** key -> { t: 译文, ts: 最后命中时间 } */
let mem = new Map();
let loading = null;
let dirty = false;
let flushTimer = null;

/**
 * fingerprint 由 promptFingerprint() 给出，已经含 PROMPT_VERSION、目标语言、
 * preset 指令、页面画像与自定义指令。改了翻译语义就不会再吃到旧译文。
 */
export function cacheKey({ providerId, endpoint = '', model, fingerprint, text }) {
  return hashString([providerId, endpoint, model, fingerprint, text].join('\u0001'));
}

/** 共享同一个 promise：并发初始化时只读一次 storage。 */
export async function initCache() {
  if (!loading) {
    loading = (async () => {
      try {
        const stored = await chrome.storage.local.get(STORE_KEY);
        const obj = stored[STORE_KEY];
        if (obj && typeof obj === 'object') mem = new Map(Object.entries(obj));
      } catch {
        mem = new Map();
      }
    })();
  }
  return loading;
}

/** 旧条目即使还带 g 字段也只读取译文；术语状态不再由缓存恢复。 */
export function getCached(key) {
  const hit = mem.get(key);
  if (!hit || typeof hit.t !== 'string') return null;
  hit.ts = Date.now();
  return hit.t;
}

export function putCached(key, text) {
  mem.set(key, { t: text, ts: Date.now() });
  dirty = true;
  scheduleFlush();
}

export function cacheStats() {
  return { entries: mem.size };
}

export async function clearCache() {
  mem = new Map();
  dirty = false;
  await chrome.storage.local.remove(STORE_KEY);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, LIMITS.CACHE_FLUSH_MS);
}

/** 批量落盘：翻译过程中每句都写一次 storage 会明显拖慢 service worker。 */
export async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!dirty) return;
  dirty = false;

  if (mem.size > LIMITS.CACHE_MAX_ENTRIES) {
    const sorted = [...mem.entries()].sort((a, b) => b[1].ts - a[1].ts);
    mem = new Map(sorted.slice(0, LIMITS.CACHE_MAX_ENTRIES));
  }
  try {
    await chrome.storage.local.set({ [STORE_KEY]: Object.fromEntries(mem) });
  } catch {
    dirty = true;
  }
}
