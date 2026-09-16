import { MSG } from '../shared/constants.js';

const connections = new WeakMap();
function openConnection(session, config, resumeFrom) {
  return chrome.runtime.sendMessage({
    type: MSG.OPEN_SESSION,
    payload: { sessionId: session.id, semanticRevision: config?.semanticRevision,
      ...(resumeFrom ? { resumeFrom } : {}) }
  }).catch(() => ({ ok: false, code: 'connection-error', error: { message: '无法连接翻译后台，请重试' } }));
}

export async function connectSession(session, config, previous = null) {
  if (!session.isActive()) return { ok: false, code: 'aborted' };
  if (previous) {
    const pending = connections.get(session);
    const current = await pending;
    if (!session.isActive()) return { ok: false, code: 'aborted' };
    if (current === previous && pending === connections.get(session)) {
      connections.set(session, openConnection(session, config, previous.workerEpoch));
    }
  } else if (!connections.has(session)) {
    connections.set(session, openConnection(session, config));
  }
  const pending = connections.get(session);
  const response = await pending;
  if (response.code === 'connection-error' && connections.get(session) === pending) connections.delete(session);
  if (!session.isActive()) {
    await chrome.runtime.sendMessage({ type: MSG.ABORT_SESSION, payload: { sessionId: session.id } }).catch(() => {});
  }
  return session.isActive() ? response : { ok: false, code: 'aborted' };
}

/** Replay only a rejected, unexecuted request after a confirmed worker restart. */
export async function requestSession(session, config, message, onReconnect = () => {}) {
  const opened = await connectSession(session, config);
  if (!opened.ok) return opened;
  if (!session.isActive()) return { ok: false, code: 'aborted' };
  const result = await chrome.runtime.sendMessage(message);
  if (result?.code !== 'session-expired' || !opened.workerEpoch ||
      !result.workerEpoch || result.workerEpoch === opened.workerEpoch) return result;
  if (!session.isActive()) return { ok: false, code: 'aborted' };
  const restored = await connectSession(session, config, opened);
  if (!restored.ok) return restored;
  onReconnect();
  if (!session.isActive()) return { ok: false, code: 'aborted' };
  return chrome.runtime.sendMessage(message);
}
