import assert from 'node:assert/strict';
import { createPageSession } from '../src/content/session.js';
import { requestSession } from '../src/content/connection.js';
import { MSG } from '../src/shared/constants.js';

const config = { semanticRevision: 'fixed-revision' };
const message = session => ({ type: MSG.TRANSLATE_CHUNK, payload: { sessionId: session.id } });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const install = sendMessage => { globalThis.chrome = { runtime: { sendMessage } }; };

test('初次并发登记共享同一任务', async () => {
  let opens = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION) { opens++; return { ok: true, workerEpoch: 'a' }; }
    return { ok: true };
  });
  const session = createPageSession();
  await Promise.all([1, 2, 3].map(() => requestSession(session, config, message(session))));
  assert.equal(opens, 1);
});
test('通道中断执行状态未知，不自动重发付费请求', async () => {
  let requests = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION) return { ok: true, workerEpoch: 'a' };
    requests++; throw Error('message port closed');
  });
  const session = createPageSession();
  await assert.rejects(requestSession(session, config, message(session)), /port closed/);
  assert.equal(requests, 1);
});
test('同代次失效和没有代次证据的失败都不自动重连', async () => {
  for (const epoch of ['a', undefined]) {
    let opens = 0;
    install(async msg => {
      if (msg.type === MSG.OPEN_SESSION) { opens++; return { ok: true, workerEpoch: 'a' }; }
      return { ok: false, code: 'session-expired', workerEpoch: epoch };
    });
    const session = createPageSession();
    assert.equal((await requestSession(session, config, message(session))).code, 'session-expired');
    assert.equal(opens, 1);
  }
});
test('一条请求最多恢复一次，即使后台连续重启', async () => {
  let epoch = 0;
  let requests = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION) return { ok: true, workerEpoch: String(++epoch) };
    requests++; return { ok: false, code: 'session-expired', workerEpoch: String(epoch + 1) };
  });
  const session = createPageSession();
  assert.equal((await requestSession(session, config, message(session))).code, 'session-expired');
  assert.equal(epoch, 2);
  assert.equal(requests, 2);
});
test('重连登记期间主动停止，迟到登记被取消且不发送翻译', async () => {
  const gate = deferred();
  const started = deferred();
  let opens = 0;
  let requests = 0;
  let aborts = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION) {
      if (++opens === 1) return { ok: true, workerEpoch: 'a' };
      assert.equal(msg.payload.resumeFrom, 'a');
      started.resolve(); await gate.promise;
      return { ok: true, workerEpoch: 'b' };
    }
    if (msg.type === MSG.ABORT_SESSION) { aborts++; return { ok: true }; }
    requests++; return { ok: false, code: 'session-expired', workerEpoch: 'b' };
  });
  const session = createPageSession();
  const pending = requestSession(session, config, message(session));
  await started.promise;
  session.invalidate(); gate.resolve();
  assert.equal((await pending).code, 'aborted');
  assert.equal(requests, 1);
  assert.equal(aborts, 1);
});
test('首次登记的暂时断连不会永久缓存失败，后续显式操作可重试', async () => {
  let opens = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION && ++opens === 1) throw Error('offline');
    return { ok: true, workerEpoch: 'a' };
  });
  const session = createPageSession();
  assert.equal((await requestSession(session, config, message(session))).code, 'connection-error');
  assert.equal((await requestSession(session, config, message(session))).ok, true);
});
test('重连检查权限失败时，不重发翻译请求', async () => {
  let opens = 0;
  let requests = 0;
  install(async msg => {
    if (msg.type === MSG.OPEN_SESSION) return ++opens === 1
      ? { ok: true, workerEpoch: 'a' } : { ok: false, code: 'no-permission' };
    requests++; return { ok: false, code: 'session-expired', workerEpoch: 'b' };
  });
  const session = createPageSession();
  assert.equal((await requestSession(session, config, message(session))).code, 'no-permission');
  assert.equal(requests, 1);
});

let failures = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('  ✓', name); }
  catch (error) { failures++; console.error('  ✗', name, error); }
}
console.log(failures ? `${failures} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failures ? 1 : 0;
