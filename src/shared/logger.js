let debugOn = false;

export function setDebug(v) {
  debugOn = Boolean(v);
}

export function log(...args) {
  if (debugOn) console.log('%c[BYOM]', 'color:#F2783C;font-weight:600', ...args);
}

export function warn(...args) {
  console.warn('[BYOM]', ...args);
}

export function error(...args) {
  console.error('[BYOM]', ...args);
}

/** 模型接口错误。retryable 决定队列是否重试。 */
export class ApiError extends Error {
  constructor(message, { status = 0, body = '', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 把任意异常压成可以跨 message 边界传输的普通对象 */
export function toPlainError(e) {
  if (!e) return { message: '未知错误' };
  return {
    message: String(e.message || e),
    status: e.status || 0,
    body: typeof e.body === 'string' ? e.body.slice(0, 400) : ''
  };
}
