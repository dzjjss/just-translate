import { PROMPT_VERSION } from '../shared/constants.js';
import { hashString } from '../shared/hash.js';
import { normalizeRules } from '../shared/rules-yaml.js';
import { semanticRevision } from '../shared/settings.js';
import { cacheGeneration, getCached, putCached, trimCacheNamespace } from './cache.js';

// v2 requires literal source spans and requests YAML without forced JSON mode.
// Translation prompt/cache versions are independent of this profiling contract.
const PREFIX = 'preflight:v2:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORD_CHARS = 16000;

/** Full source identity protects the unsampled portion of a long page as well. */
export function preflightCacheKey({ identity, digest, context = {}, settings }) {
  if (typeof identity !== 'string' || !identity || identity.length > 128) return null;
  return PREFIX + hashString(JSON.stringify({
    identity, digest, title: context.title || '', hostname: context.hostname || '',
    provider: settings.providerId, endpoint: settings.apiBase, model: settings.model,
    target: settings.targetLang, prompt: PROMPT_VERSION, revision: semanticRevision(settings)
  }));
}

export function readPreflightCache(key) {
  if (!key) return null;
  const raw = getCached(key);
  if (!raw || raw.length > MAX_RECORD_CHARS) return null;
  try {
    const value = JSON.parse(raw);
    const age = Date.now() - value.createdAt;
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS ||
        !value.profile || typeof value.profile !== 'object' || Array.isArray(value.profile)) return null;
    return { profile: normalizeRules(value.profile), reused: true, cacheSource: 'background-cache', usage: null };
  } catch { return null; }
}

/** Latest request owns this key; preserve the last valid profile while refreshing. */
export function beginPreflightCache(key) {
  if (!key) return null;
  const requestId = globalThis.crypto.randomUUID();
  let previous = {};
  try { previous = JSON.parse(getCached(key) || '{}') || {}; } catch {}
  const raw = JSON.stringify({ ...previous, requestId });
  putCached(key, raw.length <= MAX_RECORD_CHARS ? raw : JSON.stringify({ requestId }));
  trimCacheNamespace('preflight:', 128);
  return requestId;
}

function ownsRecord(key, requestId) {
  if (!requestId) return true;
  try { return JSON.parse(getCached(key) || '{}').requestId === requestId; }
  catch { return false; }
}

export function writePreflightCache(key, profile, generation, requestId) {
  if (!key || generation !== cacheGeneration() || !ownsRecord(key, requestId)) return;
  const raw = JSON.stringify({ createdAt: Date.now(), profile: normalizeRules(profile) });
  if (raw.length > MAX_RECORD_CHARS) return;
  putCached(key, raw);
  trimCacheNamespace('preflight:', 128);
}
