import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createPageSession } from '../src/content/session.js';
import { requestSession } from '../src/content/connection.js';
import { MSG } from '../src/shared/constants.js';

let stored = { settings: { schemaVersion: 13, configVersion: 1, providerId: 'openai',
  apiBase: 'https://mock.invalid/v1', apiKey: 'fixture', model: 'fixture', targetLang: 'English',
  useCache: true, autoPreflight: true, wholePageTranslation: true } };
let worker;
let sequence = 0;
let requests = 0;
let opens = 0;
const pending = new Map();
const sender = { tab: { id: 7 }, documentId: 'document-a', documentLifecycle: 'active' };
async function reboot() {
  if (worker) await worker.terminate();
  worker = new Worker(new URL('./fixtures/background-worker.mjs', import.meta.url), { workerData: stored });
  worker.on('message', result => {
    stored = result.stored;
    requests = result.requests;
    pending.get(result.id).resolve(result.response);
    pending.delete(result.id);
  });
  worker.on('error', error => { for (const task of pending.values()) task.reject(error); pending.clear(); });
}
function send(message, from = sender) {
  if (message.type === MSG.OPEN_SESSION) opens++;
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, message, sender: from });
  });
}
globalThis.chrome = { runtime: { sendMessage: send } };
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
let config;
let page;
let originalEpoch;
const context = { title: 'Battery guide', hostname: 'example.test', wholePage: true };
const chunk = session => ({ type: MSG.TRANSLATE_CHUNK, payload: { sessionId: session.id,
  items: [{ i: 1, text: '电池健康' }, { i: 2, text: '低电量模式' }], context } });

test('新页面首次预检和整页翻译各调用一次供应商', async () => {
  await reboot();
  config = (await send({ type: MSG.GET_CONFIG })).config;
  page = createPageSession();
  const profile = await requestSession(page, config, { type: MSG.PREFLIGHT, payload: {
    sessionId: page.id, identity: 'full-source-a', digest: '电池健康与低电量模式', context
  } });
  assert.equal(profile.reused, false);
  assert.equal(requests, 1);
  const translated = await requestSession(page, config, chunk(page));
  assert.deepEqual(translated.failed, []);
  assert.equal(translated.runtime.translateRequestCount, 1);
  assert.equal(requests, 2);
  originalEpoch = (await send({ type: MSG.OPEN_SESSION, payload: { sessionId: page.id } })).workerEpoch;
  await send({ type: MSG.ABORT_SESSION, payload: { sessionId: 'unused-flush-id' } });
});
test('销毁后台线程后并发请求只重新登记一次，保留已有缓存', async () => {
  await reboot();
  let reconnects = 0;
  const before = opens;
  const results = await Promise.all([1, 2].map(() => requestSession(page, config, chunk(page), () => reconnects++)));
  for (const result of results) {
    assert.equal(result.runtime.wholePageCacheHit, true);
    assert.equal(result.runtime.translateRequestCount, 0);
  }
  assert.equal(reconnects, 2, '两个请求均应获得恢复结果');
  assert.equal(opens - before, 1, '并发恢复只能发一次 OPEN_SESSION');
  assert.equal(requests, 0);
  const opened = await send({ type: MSG.OPEN_SESSION, payload: { sessionId: page.id } });
  assert.notEqual(opened.workerEpoch, originalEpoch);
});
test('同一后台里的主动取消不允许自动复活', async () => {
  await send({ type: MSG.ABORT_SESSION, payload: { sessionId: page.id } });
  const result = await requestSession(page, config, chunk(page), () => assert.fail('取消不应重连'));
  assert.equal(result.code, 'session-expired');
  assert.equal(requests, 0);
});
test('再次销毁后台并建立全新页面会话，预检及整页均零供应商请求', async () => {
  await reboot();
  page = createPageSession();
  const result = await requestSession(page, config, { type: MSG.PREFLIGHT, payload: {
    sessionId: page.id, identity: 'full-source-a', digest: '电池健康与低电量模式', context
  } });
  assert.equal(result.reused, true);
  assert.equal(result.cacheSource, 'background-cache');
  assert.equal(result.usage, null);
  const translation = await requestSession(page, config, chunk(page));
  assert.equal(translation.runtime.wholePageCacheHit, true);
  assert.equal(requests, 0);
});
test('后台重启后发现翻译配置变化，拒绝恢复旧页面任务', async () => {
  stored.settings.targetLang = 'French';
  await reboot();
  const result = await requestSession(page, config, chunk(page));
  assert.equal(result.code, 'config-changed');
  assert.equal(requests, 0);
});
test('验收日志跨后台销毁保留，回收与缓存命中都能取证', async () => {
  const res = await send({ type: MSG.GET_LIFECYCLE_LOG }, { tab: null });
  assert.equal(res.ok, true);
  const events = res.lifecycle.events;
  assert.equal(res.lifecycle.format, 'just-translate-lifecycle/v2');
  assert.equal(events[0].n, 1, '第一条事件应在最早一次启动时写下，销毁后台不清空');
  const starts = events.filter(row => row.event === 'worker-start');
  assert.equal(starts.length, 4, '记录后台代次变化，但不能推断变化的原因');
  assert.equal(new Set(starts.map(row => row.details.epoch)).size, 4, '每次启动的 epoch 必须不同');
  const chunks = events.filter(row => row.event === 'translate-chunk');
  assert.ok(chunks.some(row => row.details.wholePageCacheHit === true && row.details.requests === 0),
    '缓存命中批次必须带 wholePageCacheHit 与请求数');
  assert.ok(events.some(row => row.event === 'session-abort' && row.details.stopped === true));
  assert.ok(events.some(row => row.event === 'session-open'));
  assert.ok(events.some(row => row.event === 'preflight' && row.details.reused === true));
  const preflights = events.filter(row => row.event === 'preflight');
  assert.ok(preflights.some(row => row.details.cacheSource === 'fresh' && row.details.requests === 1));
  assert.ok(preflights.some(row => row.details.cacheSource === 'background-cache' && row.details.requests === 0));
  assert.ok(preflights.every(row => row.details.session && row.details.epoch));
  assert.ok(events.every(row => !JSON.stringify(row).includes('fixture')), '日志不得带出 Key');
  assert.equal(requests, 0, '取证本身不触发任何供应商请求');
});
test('清空验收日志由用户显式发起，清完序号重新开始', async () => {
  assert.equal((await send({ type: MSG.CLEAR_LIFECYCLE_LOG }, { tab: null })).ok, true);
  const after = await send({ type: MSG.GET_LIFECYCLE_LOG }, { tab: null });
  assert.equal(after.lifecycle.events.length, 1);
  assert.equal(after.lifecycle.events[0].event, 'capture-start');
  assert.equal(after.lifecycle.events[0].details.epoch, after.lifecycle.epoch);
  assert.equal(after.lifecycle.droppedBefore, 0);
});
test('清空后只重启一次也保留新旧两个代次', async () => {
  const before = await send({ type: MSG.GET_LIFECYCLE_LOG }, {});
  await reboot();
  const after = await send({ type: MSG.GET_LIFECYCLE_LOG }, {});
  assert.deepEqual(after.lifecycle.events.map(row => row.event), ['capture-start', 'worker-start']);
  assert.equal(after.lifecycle.events[0].details.epoch, before.lifecycle.epoch);
  assert.notEqual(after.lifecycle.epoch, before.lifecycle.epoch);
});
test('内容脚本不能读取或清空验收日志', async () => {
  for (const type of [MSG.GET_LIFECYCLE_LOG, MSG.CLEAR_LIFECYCLE_LOG]) {
    assert.equal((await send({ type })).code, 'forbidden');
  }
});

let failures = 0;
try {
  for (const [name, fn] of cases) {
    try { await fn(); console.log('  ✓', name); }
    catch (error) { failures++; console.error('  ✗', name, error); }
  }
} finally { await worker?.terminate(); }
console.log(failures ? `${failures} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failures ? 1 : 0;
