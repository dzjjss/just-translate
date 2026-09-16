/** Explicit registration: a translation request must never create a session. */
const sessions = new Map();
// Changes only when the worker starts again. This is identity, not a keepalive.
export const workerEpoch = globalThis.crypto.randomUUID();

function cancelled() {
  return Object.assign(new DOMException('后台会话已失效，请重新开始翻译', 'AbortError'), { reasonCode: 'session-expired' });
}

export function openSession(id) {
  if (!id || typeof id !== 'string') throw new Error('缺少会话标识');
  const existing = sessions.get(id);
  if (existing) return existing;
  const record = { controller: new AbortController(), settings: null };
  sessions.set(id, record);
  return record;
}

export function sessionRecord(id, expected) {
  const record = sessions.get(id);
  if (!record || record.controller.signal.aborted || (expected && record !== expected)) throw cancelled();
  return record;
}

export function sessionSignal(id) {
  return sessionRecord(id).controller.signal;
}

export function abortSession(id) {
  const record = sessions.get(id);
  if (!record) return false;
  record.controller.abort();
  sessions.delete(id);
  return true;
}

export function abortTab(tabId) {
  let count = 0;
  for (const key of sessions.keys()) {
    if (key.startsWith(`${tabId}:`)) count += Number(abortSession(key));
  }
  return count;
}

/** Recheck permissions for registered sessions without creating or reopening any. */
export async function abortDisallowedSessions(allowed) {
  await Promise.all([...sessions.entries()].map(async ([id, record]) => {
    try {
      const settings = await record.settings;
      const permitted = await allowed(settings);
      if (sessions.get(id) === record && !permitted) abortSession(id);
    } catch {
      if (sessions.get(id) === record) abortSession(id);
    }
  }));
}
