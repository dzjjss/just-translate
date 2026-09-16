/**
 * 生命周期验收日志。
 *
 * 和一次性诊断的分工：那份活在内容脚本内存里，页面刷新就没了，
 * 而需要取证的恰好是这两件事。这份写在 storage.session —— service worker 被回收
 * 不影响它，浏览器关闭时自动消失，不落磁盘，默认也不对内容脚本开放。
 *
 * 约束：
 * - 单一写入者串行落盘，并发批次不会互相覆盖；
 * - 环形上限，长时间开着不会无限增长；丢弃量如实报告，不假装完整；
 * - 内容仍过 sanitizeDiagnosticValue，Key、正文、query 不进日志。
 */
import { sanitizeDiagnosticValue } from '../shared/diagnostics.js';

const KEY = 'lifecycleLog';
const MAX_EVENTS = 240;

// Supported Chrome versions provide session storage. Never silently persist these logs to disk.
function area() {
  if (!chrome.storage.session) throw new Error('Session storage unavailable');
  return chrome.storage.session;
}

let lifecycleWrites = Promise.resolve();
// Pending failures are folded into session storage on the next successful write.
// A hard worker termination before that write can still lose this pending count.
let writeFailures = 0;

async function readLog() {
  const stored = await area().get(KEY);
  const value = stored?.[KEY];
  if (value == null) return { sequence: 0, events: [] };
  if (!Array.isArray(value.events) || !Number.isSafeInteger(value.sequence) || value.sequence < value.events.length) {
    throw Object.assign(new Error('Invalid lifecycle log'), { code: 'invalid-log' });
  }
  if (value.writeFailures != null &&
      (!Number.isSafeInteger(value.writeFailures) || value.writeFailures < 0)) {
    throw Object.assign(new Error('Invalid lifecycle log'), { code: 'invalid-log' });
  }
  return value;
}

function chain(operation) {
  lifecycleWrites = operation.then(() => {}, () => {});
  return operation;
}

/**
 * 后台侧事件入口。调用方不必等待落盘，写入顺序由这条链保证。
 * 永不 reject：记录失败不能反过来把翻译请求打断，也不该留下未处理的 rejection。
 */
export function recordLifecycle(event, details = {}) {
  const at = new Date().toISOString();
  const safe = sanitizeDiagnosticValue(details) || {};
  return chain(lifecycleWrites.then(async () => {
    const log = await readLog();
    const row = {
      n: log.sequence + 1,
      at,
      event: String(event).slice(0, 64),
      details: safe
    };
    await area().set({ [KEY]: { sequence: row.n, events: [...log.events, row].slice(-MAX_EVENTS),
      writeFailures: (log.writeFailures || 0) + writeFailures } });
    writeFailures = 0;
    return row;
  }).catch(() => { writeFailures++; return null; }));
}

export function lifecycleSnapshot(meta = {}) {
  const header = {
    format: 'just-translate-lifecycle/v2',
    privacy: 'No API key, page text, translation text, prompt, response body, URL query or hash.',
    ...sanitizeDiagnosticValue(meta)
  };
  // A read occupies the same queue: prior writes finish first, later clears cannot overtake it.
  return chain(lifecycleWrites.then(async () => {
    try {
      const log = await readLog();
      return { ...header, writeFailures: (log.writeFailures || 0) + writeFailures, droppedBefore: log.sequence - log.events.length,
        eventCount: log.events.length, events: log.events };
    } catch (error) {
      return { ...header, unavailable: true, reason: error?.code || 'storage-unavailable', writeFailures,
        droppedBefore: null, eventCount: null, events: [] };
    }
  }));
}

/** 清空只由用户显式发起：验收要分场景取证，自动清会把上一段证据抹掉。 */
export function clearLifecycleLog(meta = {}) {
  return chain(lifecycleWrites.then(async () => {
    const row = { n: 1, at: new Date().toISOString(), event: 'capture-start',
      details: sanitizeDiagnosticValue(meta) || {} };
    await area().set({ [KEY]: { sequence: 1, events: [row], writeFailures: 0 } });
    writeFailures = 0;
  }))
    .then(() => true, () => false);
}
