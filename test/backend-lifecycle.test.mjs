import assert from 'node:assert/strict';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async fire(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } });
const changed = event();
const sessionStored = {};
let stored = { settings: { schemaVersion: 13, configVersion: 1, providerId: 'openai', apiBase: 'https://mock.invalid/v1', apiKey: 'test-key', model: 'mock', targetLang: 'English', useCache: false } };
let permitted = true;
let deliveries = [];
let contentUnavailable = false;
let locked = false;
let requests = 0;
const onMessage = event();
globalThis.chrome = {
  storage: { local: {
    async get(key) { return structuredClone({ [key]: stored[key] }); },
    async set(value) { Object.assign(stored, structuredClone(value)); },
    async remove(key) { delete stored[key]; },
    async setAccessLevel() { locked = true; }
  }, session: {
    async get(key) { return structuredClone({ [key]: sessionStored[key] }); },
    async set(value) { Object.assign(sessionStored, structuredClone(value)); }
  }, onChanged: changed },
  permissions: { async contains() { return permitted; }, onRemoved: event() },
  runtime: { onMessage, onSuspend: event() },
  commands: { onCommand: event() },
  tabs: {
    onRemoved: event(), onUpdated: event(),
    async query() { return [{ id: 1, url: 'https://page.invalid/' }]; },
    async get(id) { return { id, url: 'https://page.invalid/' }; },
    async sendMessage(id, msg) {
      deliveries.push({ id, ...msg });
      if (contentUnavailable) throw Error('Receiving end does not exist');
      return { ok: true, running: false };
    }
  },
  scripting: { async insertCSS() {}, async executeScript() {} }
};
globalThis.fetch = async () => { requests++; throw TypeError('Failed to fetch'); };
const { MSG, LIMITS } = await import('../src/shared/constants.js');
const { openSession, sessionRecord, abortSession, abortDisallowedSessions } = await import('../src/background/sessions.js');
const { handlers, installRouter } = await import('../src/background/router.js');
await import('../src/background/service-worker.js');
const send = (type, payload = {}, sender = { tab: { id: 1, url: 'https://page.invalid/' } }) => new Promise(resolve => {
  const accepted = onMessage.listeners[0]({ type, payload }, sender, resolve);
  if (!accepted) resolve(null);
});
const payload = id => ({ sessionId: id, items: [{ i: 1, text: 'Source sentence.' }], context: { presetId: 'general' } });
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('真正加载 service-worker 入口并等待启动，页面配置不含凭据', async () => {
  const result = await send(MSG.GET_CONFIG);
  assert.equal(locked, true);
  assert.equal(result.ok, true);
  assert.equal(result.config.apiKey, undefined);
  assert.equal(result.config.apiBase, undefined);
});
test('消息白名单拒绝页面写设置与原型属性', async () => {
  const before = stored.settings.model;
  assert.equal((await send(MSG.SAVE_SETTINGS, { patch: { model: 'evil' } })).code, 'forbidden');
  assert.equal(stored.settings.model, before);
  assert.equal(await send('toString'), null);
});
test('启动失败被转换为可回应结果，不产生无人处理的 rejection', async () => {
  installRouter(Promise.reject(Error('storage failed')));
  const result = await new Promise(resolve => onMessage.listeners.at(-1)({ type: MSG.GET_CONFIG }, {}, resolve));
  assert.equal(result.code, 'startup-failed');
  assert.match(result.error.message, /storage failed/);
});
test('取消登记中的会话不能在异步读取后重新出现', async () => {
  const pending = send(MSG.OPEN_SESSION, { sessionId: 'early-cancel' });
  await Promise.resolve();
  abortSession('1:early-cancel');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.throws(() => sessionRecord('1:early-cancel'), { name: 'AbortError' });
});
test('导航与关闭仅取消对应标签页', async () => {
  openSession('1:navigate'); openSession('2:other');
  await chrome.tabs.onUpdated.fire(1, { status: 'loading' });
  assert.throws(() => sessionRecord('1:navigate'));
  assert.ok(sessionRecord('2:other'));
  await chrome.tabs.onRemoved.fire(2);
  assert.throws(() => sessionRecord('2:other'));
});
test('停止不依赖页面回答，失效会话不发请求', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'stop' });
  contentUnavailable = true;
  try { assert.equal((await handlers[MSG.STOP_ON_TAB]({ tabId: 1 })).ok, true); }
  finally { contentUnavailable = false; }
  const before = requests;
  assert.equal((await send(MSG.TRANSLATE_CHUNK, payload('stop'))).code, 'session-expired');
  assert.equal(requests, before);
});
test('权限撤回后下一批在网络调用前拒绝', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'permission' });
  permitted = false;
  const before = requests;
  try {
    assert.equal((await send(MSG.TRANSLATE_CHUNK, payload('permission'))).code, 'no-permission');
    assert.equal(requests, before);
  } finally { permitted = true; }
});
test('权限撤回事件中止在途请求信号', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'inflight' });
  const signal = sessionRecord('1:inflight').controller.signal;
  permitted = false;
  await chrome.permissions.onRemoved.fire({ origins: ['https://mock.invalid/*'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  permitted = true;
  assert.equal(signal.aborted, true);
});
test('迟到权限检查不能取消同 ID 的新登记', async () => {
  openSession('race').settings = Promise.resolve({});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = abortDisallowedSessions(() => gate);
  await Promise.resolve();
  abortSession('race');
  const replacement = openSession('race');
  release(false);
  await pending;
  assert.equal(sessionRecord('race'), replacement);
  abortSession('race');
});
test('断网返回明确失败并保留实际请求计数', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'offline' });
  const result = await send(MSG.TRANSLATE_CHUNK, payload('offline'));
  assert.deepEqual(result.failed, [1]);
  assert.equal(result.runtime.translateRequestCount, 1);
  assert.match(result.error.message, /Failed to fetch/);
  abortSession('1:offline');
});
test('请求权限检查返回时登记已替换，旧任务不取消新登记', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'replace-check' });
  const original = chrome.permissions.contains;
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  chrome.permissions.contains = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = send(MSG.TRANSLATE_CHUNK, payload('replace-check'));
  await ready;
  abortSession('1:replace-check');
  const replacement = openSession('1:replace-check');
  replacement.settings = Promise.resolve(stored.settings);
  release(false);
  try {
    assert.equal((await pending).code, 'session-expired');
    assert.equal(sessionRecord('1:replace-check'), replacement);
  } finally { chrome.permissions.contains = original; abortSession('1:replace-check'); }
});
test('设置广播只下发运行时字段', async () => {
  deliveries = [];
  await changed.fire({ settings: { newValue: { ...stored.settings, configVersion: 9 } } }, 'local');
  const config = deliveries.find(msg => msg.type === MSG.CONFIG_CHANGED).payload.config;
  assert.equal(config.configVersion, 9);
  assert.equal(config.apiKey, undefined);
});

test('快捷键经过启动闸门并转交当前标签页', async () => {
  deliveries = [];
  await chrome.commands.onCommand.fire('toggle-translations');
  assert.ok(deliveries.some(message => message.type === MSG.TOGGLE_VISIBILITY && message.id === 1));
});

const { anthropicWire } = await import('../src/background/providers/anthropic.js');
const { openaiWire } = await import('../src/background/providers/openai.js');
const { readError } = await import('../src/background/providers/http.js');
test('Anthropic 正常/空/损坏结构保留 usage，不把对象误当 text', async () => {
  for (const content of [[{ type: 'text', text: 'Hello' }], [], { text: 'wrong shape' }, [{ type: 'text', text: {} }]]) {
    let observed;
    let attempt = 0;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer test');
      return new Response(JSON.stringify({ content, usage: { input_tokens: 4, output_tokens: 2 } }));
    };
    const task = anthropicWire.complete({ base: 'https://mock.invalid/v1', apiKey: 'test', auth: 'bearer', onAttempt: () => attempt++, onUsage: value => { observed = value; } });
    if (content[0]?.text === 'Hello') assert.equal((await task).text, 'Hello');
    else await assert.rejects(task, { name: 'ApiError' });
    assert.equal(attempt, 1);
    assert.deepEqual(observed, { input_tokens: 4, output_tokens: 2 });
  }
});
test('普通 HTTP 400 不冒充 JSON 协议降级；认证失败不重试', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('unrelated error', { status }); };
    await assert.rejects(openaiWire.complete({ base: 'https://mock.invalid/v1', model: `m${status}` }), { status });
    assert.equal(calls, 1);
  }
});
test('Retry-After 秒数/HTTP 日期与 context 错误分类', async () => {
  const seconds = await readError(new Response('', { status: 429, headers: { 'retry-after': '3' } }), 'https://a.invalid');
  assert.equal(seconds.retryAfterMs, 3000);
  const date = new Date(Date.now() + 60000).toUTCString();
  const dated = await readError(new Response('', { status: 503, headers: { 'retry-after': date } }), 'https://a.invalid');
  assert.ok(dated.retryAfterMs > 58000 && dated.retryAfterMs <= 60000);
  assert.equal((await readError(new Response('context_length_exceeded', { status: 400 }), '')).recoverBySplit, true);
  assert.equal((await readError(new Response('invalid model', { status: 400 }), '')).recoverBySplit, false);
});

test('loader 重复注入幂等，模块加载失败时复位', async () => {
  globalThis.window = {};
  let loads = 0;
  chrome.runtime.getURL = () => { loads++; return 'data:text/javascript,export default true'; };
  await import('../src/content/loader.js?first');
  await new Promise(resolve => setTimeout(resolve, 0));
  await import('../src/content/loader.js?second');
  assert.equal(loads, 1);
  assert.equal(window.__BYOM_LOADED__, true);
  window.__BYOM_LOADED__ = false;
  chrome.runtime.getURL = () => 'data:text/javascript,throw new Error("test failure")';
  const original = console.error;
  console.error = () => {};
  try {
    await import('../src/content/loader.js?failure');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(window.__BYOM_LOADED__, false);
  } finally { console.error = original; delete globalThis.window; }
});

test('局部失败在验收日志里带失败类别，事后能判读是哪一类', async () => {
  const network = globalThis.fetch;
  // 200 但没返回任何条目：拆分重试跑满后仍然缺条目，属于 missing-items 而不是网络失败。
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }));
  };
  try {
    await send(MSG.OPEN_SESSION, { sessionId: 'category-probe' });
    const result = await send(MSG.TRANSLATE_CHUNK, payload('category-probe'));
    assert.equal(result.failed.length, 1);
  } finally {
    globalThis.fetch = network;
  }
  const log = await send(MSG.GET_LIFECYCLE_LOG, {}, {});
  const chunk = log.lifecycle.events.filter(row => row.event === 'translate-chunk').at(-1);
  assert.equal(chunk.details.failed, 1);
  assert.equal(chunk.details.failureCategory, 'missing-items', '只记数字不记原因，事后无法判断失败类别');
  const clean = log.lifecycle.events.find(row => row.event === 'translate-chunk' && !row.details.failed);
  if (clean) assert.equal(clean.details.failureCategory, '', '成功批次不该带失败类别');
});

test('超长源单元的合成错误仍分类为 source-limit，计数与会话不被脱敏误删', async () => {
  await send(MSG.OPEN_SESSION, { sessionId: 'source-limit' });
  const before = requests;
  const result = await send(MSG.TRANSLATE_CHUNK, { ...payload('source-limit'),
    items: [{ i: 1, text: 'x'.repeat(LIMITS.MAX_REQUEST_SOURCE_CHARS + 1) }] });
  assert.equal(result.runtime.sourceLimitFailedUnits, 1);
  assert.equal(requests, before);
  const log = await send(MSG.GET_LIFECYCLE_LOG, {}, {});
  const row = log.lifecycle.events.at(-1);
  assert.equal(row.details.unitCount, 1);
  assert.equal(row.details.sourceLimitFailedUnits, 1);
  assert.equal(row.details.failureCategory, 'source-limit');
  assert.equal(row.details.session, '1:source-limit');
  assert.equal(row.details.epoch, log.lifecycle.epoch);
  assert.equal(row.details.requests, 0);
});

test('请求发出后取消，翻译和预检失败日志都保留实际请求数', async () => {
  const network = globalThis.fetch;
  try {
    for (const type of [MSG.TRANSLATE_CHUNK, MSG.PREFLIGHT]) {
      const id = `abort-${type}`;
      await send(MSG.OPEN_SESSION, { sessionId: id });
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        requests++;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        entered();
      });
      const before = requests;
      const pending = send(type, { ...payload(id), digest: 'Battery guide' });
      await started;
      await send(MSG.ABORT_SESSION, { sessionId: id });
      const result = await pending;
      assert.equal(requests - before, 1);
      assert.equal(result.runtime.translateRequestCount, 1);
      assert.deepEqual(result.runtime.requestReasons, { initial: 1 });
      assert.equal(result.usageIncomplete, true);
      const log = await send(MSG.GET_LIFECYCLE_LOG, {}, {});
      const row = log.lifecycle.events.at(-1);
      assert.equal(row.event, type === MSG.PREFLIGHT ? 'preflight-failed' : 'translate-failed');
      assert.equal(row.details.requests, 1);
      assert.deepEqual(row.details.requestReasons, { initial: 1 });
      assert.equal(row.details.usageIncomplete, true);
      assert.equal(row.details.session, `1:${id}`);
      assert.equal(row.details.failureCategory, 'aborted');
    }
  } finally { globalThis.fetch = network; }
});

test('非法会话的失败日志不使处理器再次抛错，也不声称发过请求', async () => {
  const before = requests;
  const result = await send(MSG.TRANSLATE_CHUNK, { ...payload(''), sessionId: {} });
  assert.equal(result.ok, false);
  assert.equal(requests, before);
  const log = await send(MSG.GET_LIFECYCLE_LOG, {}, {});
  const row = log.lifecycle.events.at(-1);
  assert.equal(row.event, 'translate-failed');
  assert.equal(row.details.requests, 0);
});

let failures = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}`, error); }
}
console.log(failures ? `${failures} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failures ? 1 : 0;
