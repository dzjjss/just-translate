/**
 * 一次性诊断日志只服务故障定位，不是另一套 telemetry。
 *
 * 设计约束：
 * - 只在内存里保存，调用方负责随页面会话重建；
 * - 环形上限防止长时间打开 SPA 后无限增长；
 * - 即使调用方误把原文或凭证塞进 details，也在这一层做最后一道剔除/脱敏。
 */

const DEFAULT_LIMIT = 80;
let logSequence = 0;
const MAX_STRING = 320;
const OMIT_KEYS = /^(?:apiKey|authorization|cookie|setCookie|password|secret|credential|accessToken|refreshToken|idToken|body|requestBody|responseBody|prompt|system|user|items|text|digest|source|translation|profile|profileYaml|rulesText|customPrompt)$/i;
const URL_KEYS = /^(?:url|pageUrl|endpoint|apiBase)$/i;

function safeIso(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return '';
  }
}

function safePath(pathname) {
  return String(pathname || '/')
    .split('/')
    .map((part) => (/^[A-Za-z0-9_-]{24,}$/.test(part) ? '[id]' : part))
    .join('/');
}

/** URL 只保留协议、主机和路径；query/hash/账号密码永不进入诊断包。 */
export function sanitizeDiagnosticUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const path = safePath(url.pathname);
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${path}`;
    if (url.host) return `${url.protocol}//${url.host}${path}`;
    return url.protocol;
  } catch {
    return '[invalid-url]';
  }
}

function sanitizeString(value) {
  let out = String(value || '');
  out = out.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizeDiagnosticUrl(url));
  out = out.replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]');
  out = out.replace(/\b(api[_ -]?key|authorization|cookie|password|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]');
  return out.slice(0, MAX_STRING);
}

/**
 * 第三方端点的 error.message 也不可信：它可能原样回显请求正文。
 * 诊断包只保存可操作的错误类别，原始 message 继续只用于当前页面提示。
 */
export function classifyDiagnosticError(value, status = 0) {
  const text = String(value || '').toLowerCase();
  const code = Number(status) || 0;
  if (code === 401 || code === 403 || /认证|auth|unauthor|forbidden/.test(text)) return 'authentication';
  if (code === 404 || /接口不存在|not found/.test(text)) return 'endpoint-not-found';
  if (code === 408 || /timeout|timed out|超时/.test(text)) return 'timeout';
  if (code === 429 || /rate.?limit|速率限制|too many requests/.test(text)) return 'rate-limit';
  if (code >= 500) return 'server-error';
  if (/abort|cancel|取消|中止/.test(text)) return 'aborted';
  if (/json|parse|解析/.test(text)) return 'invalid-response';
  if (/空内容|内容为空|empty|漏项|没有返回/.test(text)) return 'empty-response';
  if (/network|fetch|网络/.test(text)) return 'network';
  if (/permission|权限|授权/.test(text)) return 'permission';
  return 'unclassified';
}

/** 把诊断值压成安全、可 structured-clone 的 JSON 子集。 */
export function sanitizeDiagnosticValue(value, { depth = 0, key = '' } = {}) {
  if (OMIT_KEYS.test(key)) return undefined;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return URL_KEYS.test(key) ? sanitizeDiagnosticUrl(value) : sanitizeString(value);
  }
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeDiagnosticValue(item, { depth: depth + 1 }));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const safe = sanitizeDiagnosticValue(childValue, { depth: depth + 1, key: childKey });
      if (safe !== undefined) out[childKey] = safe;
    }
    return out;
  }
  return sanitizeString(value);
}

export function createDiagnosticLog({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  const logId = `${now()}:${++logSequence}`;
  const max = Math.max(10, Math.min(200, Number(limit) || DEFAULT_LIMIT));
  let startedAt = now();
  let sequence = 0;
  let events = [];

  return {
    record(event, details = {}) {
      const at = now();
      const row = {
        n: ++sequence,
        at: safeIso(at),
        elapsedMs: Math.max(0, at - startedAt),
        event: sanitizeString(event).slice(0, 64),
        details: sanitizeDiagnosticValue(details) || {}
      };
      events.push(row);
      if (events.length > max) events = events.slice(-max);
      return row;
    },

    snapshot(meta = {}) {
      return {
        format: 'just-translate-diagnostic/v1',
        logId,
        throughSequence: sequence,
        generatedAt: safeIso(now()),
        startedAt: safeIso(startedAt),
        privacy: 'No API key, page text, translation text, prompt, response body, URL query or hash.',
        ...sanitizeDiagnosticValue(meta),
        eventCount: events.length,
        events: events.map((row) => ({ ...row, details: sanitizeDiagnosticValue(row.details) || {} }))
      };
    },

    clearThrough(id, through) {
      if (id !== logId || !Number.isInteger(through) || through < 0 || through > sequence) return false;
      events = events.filter(row => row.n > through);
      return true;
    },

    clear() {
      startedAt = now();
      sequence = 0;
      events = [];
    },

    get size() {
      return events.length;
    }
  };
}
