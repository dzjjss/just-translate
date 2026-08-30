import { LIMITS } from '../shared/constants.js';

/** 全局并发闸门：所有标签页共用一个，避免开五个页面把 API 打爆。 */
export class Queue {
  constructor(limit = 3) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.pending = [];
  }

  setLimit(n) {
    this.limit = Math.max(1, Number(n) || 1);
    this.#drain();
  }

  get depth() {
    return this.active + this.pending.length;
  }

  /** signal 在这里就要看一次：排队中的任务被取消后不应该再发出去 */
  add(task, signal) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, signal, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.limit && this.pending.length) {
      const job = this.pending.shift();
      if (job.signal?.aborted) {
        job.reject(abortError(job.signal));
        continue;
      }
      this.active++;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.#drain();
        });
    }
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('已取消'), { name: 'AbortError' });
}

/** 可被打断的 sleep：退避等待期间点停止，不该再等满 8 秒才发现 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true }
    );
  });
}

/** 指数退避 + 抖动；只重试 retryable 错误，尊重 Retry-After。 */
export async function withRetry(fn, { retries = LIMITS.MAX_RETRIES, signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await fn(attempt);
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (attempt >= retries || !e?.retryable) throw e;
      const backoff = e.retryAfterMs || Math.min(8000, 600 * 2 ** attempt) + Math.random() * 400;
      onRetry?.(attempt + 1, e, backoff);
      await sleep(backoff, signal);
      attempt++;
    }
  }
}
