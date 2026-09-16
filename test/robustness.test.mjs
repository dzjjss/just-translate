import assert from 'node:assert/strict';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const loading = deferred();
let stored = { cache: { old: { t: 'old cache', ts: 1 } } };
globalThis.chrome = {
  storage: { local: {
    async get(key) {
      const snapshot = structuredClone({ [key]: stored[key] });
      if (key === 'cache') await loading.promise;
      return snapshot;
    },
    async set(value) { Object.assign(stored, structuredClone(value)); },
    async remove(key) { delete stored[key]; }
  }, onChanged: { addListener() {} } },
  permissions: { async contains() { return true; } }
};
const { translateChunk, runPreflight, openSession, abortSession } = await import('../src/background/translator.js');
const { clearCache, flush, getCached } = await import('../src/background/cache.js');
const { persistSettingsPatch, getSettings, semanticRevision } = await import('../src/shared/settings.js');
const { handlers } = await import('../src/background/router.js');
const { MSG, LIMITS } = await import('../src/shared/constants.js');
const { createDiagnosticLog } = await import('../src/shared/diagnostics.js');
const { parseTranslationResponse } = await import('../src/prompt/build.js');
const { translateMachineWithRecovery } = await import('../src/background/machine-translation.js');
const { createPageSession } = await import('../src/content/session.js');

const settings = {
  schemaVersion: 13, providerId: 'openai', apiBase: 'https://mock.invalid/v1',
  apiKey: 'dummy-test-key', model: 'test', targetLang: 'English', presetId: 'general',
  customPrompt: '', background: '', useCache: false
};
const item = i => ({ i, text: `Source passage ${i}.` });
const context = { presetId: 'general' };
const response = content => new Response(JSON.stringify({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify({ items: content }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
}), { status: 200 });
let sequence = 0;
const sessions = [];
function translate(items, options = {}) {
  const sessionId = `test:${++sequence}`;
  openSession(sessionId);
  sessions.push(sessionId);
  return translateChunk({ items, context, settings, sessionId, ...options });
}
async function withoutBackoff(fn) {
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _ms, ...args) => timer(callback, 0, ...args);
  try { return await fn(); } finally { globalThis.setTimeout = timer; }
}
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('取消早于缓存加载完成时不发送请求；清空不会被迟到加载恢复', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response([{ i: 1, t: 'Result.' }]); };
  openSession('cancel-before-load');
  const pending = translateChunk({ items: [item(1)], context, settings, sessionId: 'cancel-before-load' });
  assert.equal(abortSession('cancel-before-load'), true);
  await clearCache();
  loading.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(getCached('old'), null);
  await assert.rejects(translateChunk({ items: [item(1)], context, settings, sessionId: 'cancel-before-load' }), { name: 'AbortError' });
});

test('并发设置修改不丢字段，版本单调增长', async () => {
  stored.settings = { ...settings, configVersion: 3 };
  await Promise.all([persistSettingsPatch({ targetLang: 'French' }), persistSettingsPatch({ displayMode: 'translation' })]);
  assert.equal(stored.settings.targetLang, 'French');
  assert.equal(stored.settings.displayMode, 'translation');
  assert.equal(stored.settings.configVersion, 5);
});

test('会话绑定配置快照，并拒绝旧版本登记和未登记请求', async () => {
  stored.settings = { ...settings };
  const sender = { tab: { id: 7 } };
  const revision = semanticRevision(await getSettings());
  assert.equal((await handlers[MSG.OPEN_SESSION]({ sessionId: 'bound', semanticRevision: revision }, sender)).ok, true);
  await persistSettingsPatch({ targetLang: 'French' });
  let prompt;
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return response([{ i: 1, t: 'English result.' }]);
  };
  const result = await handlers[MSG.TRANSLATE_CHUNK]({ sessionId: 'bound', items: [item(1)], context }, sender);
  assert.equal(result.ok, true);
  assert.match(prompt, /into English/);
  const stale = await handlers[MSG.OPEN_SESSION]({ sessionId: 'stale', semanticRevision: revision }, sender);
  assert.equal(stale.code, 'config-changed');
  abortSession('7:bound');
  const cancelled = await handlers[MSG.TRANSLATE_CHUNK]({ sessionId: 'bound', items: [item(1)], context }, sender);
  assert.equal(cancelled.code, 'session-expired');
});

test('后续分支认证失败不丢弃前面成功的条目', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls < 3 ? response([{ i: calls, t: `Valid result ${calls}.` }]) : new Response('Unauthorized', { status: 401 });
  };
  const result = await translate([item(1), item(2), item(3)]);
  assert.deepEqual(result.items.map(i => i.i), [1, 2]);
  assert.deepEqual(result.failed, [3]);
  assert.equal(result.error.status, 401);
});

test('相同批次的缓存命中在其他条目失败时仍返回', async () => {
  await clearCache();
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? response([{ i: 1, t: 'Cached result.' }]) : new Response('Unauthorized', { status: 401 });
  const options = { settings: { ...settings, useCache: true } };
  await translate([item(1), item(2)], options);
  const result = await translate([item(1), item(2)], options);
  assert.equal(result.items[0].cached, true);
  assert.deepEqual(result.failed, [2]);
});

test('漏项与坏 JSON 混合恢复共享 9 次硬预算', async () => {
  let calls = 0;
  globalThis.fetch = async () => [1, 2, 9].includes(++calls) ? response([]) : response('bad JSON');
  const result = await withoutBackoff(() => translate(Array.from({ length: 8 }, (_, i) => item(i + 1))));
  assert.equal(calls, LIMITS.BATCH_MAX_ATTEMPTS);
  assert.equal(result.runtime.translateRequestCount, calls);
  assert.equal(Object.values(result.runtime.requestReasons).reduce((n, count) => n + count, 0), calls);
  assert.ok(result.runtime.requestReasons['missing-items']);
  assert.ok(result.runtime.requestReasons['retry:invalid-response']);
  assert.equal(result.failed.length, 8);
});

test('协议降级的第二次 HTTP 请求计入预算', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('response_format unsupported', { status: 400 }) : response([{ i: 1, t: 'Result.' }]);
  const result = await translate([item(1)]);
  assert.equal(calls, 2);
  assert.equal(result.runtime.translateRequestCount, 2);
  assert.deepEqual(result.runtime.requestReasons, { initial: 1, 'json-format-fallback': 1 });
  assert.equal(result.usageIncomplete, true, '没有 usage 的 400 响应不能假定为免费');
});

test('坏 JSON 拆分恢复与原批重试分别计数', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 3) return response('broken JSON');
    return response((calls === 4 ? [1, 2] : [3, 4]).map(i => ({ i, t: `Result ${i}.` })));
  };
  const result = await withoutBackoff(() => translate([1, 2, 3, 4].map(item)));
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.runtime.requestReasons, { initial: 1, 'retry:invalid-response': 2, 'invalid-response': 2 });
  assert.equal(result.runtime.translateRequestCount, 5);
});

test('服务端上下文长度拒绝与坏 JSON 拆分分开标记', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response('maximum context length exceeded', { status: 400 })
    : response([{ i: calls - 1, t: 'Valid result.' }]);
  const result = await translate([item(1), item(2)], { settings: { ...settings, model: 'context-length-test' } });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.runtime.requestReasons, { initial: 1, 'context-length': 2 });
  assert.equal(result.usageIncomplete, true);
});

test('空输出响应携带的 usage 不丢失', async () => {
  globalThis.fetch = async () => response('');
  const result = await withoutBackoff(() => translate([item(1)]));
  assert.equal(result.runtime.translateRequestCount, 3);
  assert.deepEqual(result.usage, { input: 30, output: 15 });
  assert.deepEqual(result.failed, [1]);
  assert.equal(result.usageIncomplete, false);
});

test('恢复产生的整页缓存保留 recovered 来源', async () => {
  await clearCache();
  let calls = 0;
  globalThis.fetch = async () => response([{ i: ++calls, t: `Result ${calls}.` }]);
  const options = { settings: { ...settings, useCache: true }, context: { ...context, wholePage: true } };
  const first = await translate([item(1), item(2)], options);
  const cached = await translate([item(1), item(2)], options);
  assert.equal(first.runtime.recoveredContext, true);
  assert.equal(cached.runtime.wholePageCacheHit, true);
  assert.equal(cached.runtime.recoveredContext, true);
  assert.equal(cached.runtime.translateRequestCount, 0);
});

test('相同句子但页面语境不同不能共用缓存', async () => {
  await clearCache();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response([{ i: 1, t: 'Result.' }]); };
  for (const title of ['Networking', 'Fishing']) await translate([item(1)], { settings: { ...settings, useCache: true }, context: { title } });
  assert.equal(calls, 2);
});

test('超大单元不越过硬上限发出请求', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response([]); };
  const result = await translate([{ i: 1, text: 'a'.repeat(50000) }]);
  assert.equal(calls, 0);
  assert.deepEqual(result.failed, [1]);
});

test('重复输出 ID 不能静默取最后一项', () => {
  const parsed = parseTranslationResponse(JSON.stringify({ items: [{ i: 1, t: 'A' }, { i: 1, t: 'B' }] }), [1]);
  assert.deepEqual(parsed.missing, [1]);
});

test('机器翻译拒绝占位符，局部失败仍保留成功', async () => {
  const empty = await translateMachineWithRecovery({ items: [item(1)], request: async () => '-' });
  assert.deepEqual(empty.failed, [1]);
  let calls = 0;
  const partial = await translateMachineWithRecovery({ items: [item(1), item(2)], request: async () => {
    calls++;
    if (calls === 1) return 'broken boundaries';
    if (calls === 2) return 'Valid result.';
    throw new Error('Network failure');
  } });
  assert.deepEqual(partial.items.map(i => i.i), [1]);
  assert.deepEqual(partial.failed, [2]);
});

test('日志只清已导出序号，旧会话确认不能清新日志', () => {
  const log = createDiagnosticLog();
  log.record('before');
  const copied = log.snapshot();
  log.record('during-copy');
  assert.equal(log.clearThrough(copied.logId, copied.throughSequence), true);
  assert.deepEqual(log.snapshot().events.map(e => e.event), ['during-copy']);
  assert.equal(createDiagnosticLog().clearThrough(copied.logId, copied.throughSequence), false);
});

test('单元提交幂等，旧代次不能覆盖新代次或重复计数', () => {
  const session = createPageSession();
  session.start();
  const unit = { id: 1, state: 'queued' };
  session.registerUnit(unit);
  const old = session.beginAttempt([unit]).get(1);
  const current = session.beginAttempt([unit]).get(1);
  let writes = 0;
  assert.equal(session.commit(unit, old, 'done', () => { writes++; return true; }), false);
  assert.equal(session.commit(unit, current, 'done', () => { writes++; return true; }), true);
  assert.equal(session.commit(unit, current, 'done', () => { writes++; return true; }), false);
  assert.equal(writes, 1);
  assert.equal(session.done, 1);
  assert.equal(session.total, 1);
  assert.equal(session.units.set, undefined);
});

test('版本序号不是语义设置，浮点和无限并发被收束', async () => {
  const { classifyRuntimeConfigChange } = await import('../src/shared/settings.js');
  const { Queue } = await import('../src/background/queue.js');
  const changes = classifyRuntimeConfigChange({ configVersion: 1 }, { configVersion: 2 });
  assert.equal(changes.semantic, false);
  assert.deepEqual(changes.other, []);
  const queue = new Queue(Infinity);
  assert.equal(queue.limit, 8);
  queue.setLimit(2.5);
  assert.equal(queue.limit, 2);
  queue.setLimit(NaN);
  assert.equal(queue.limit, 1);
});

test('机器翻译的边界恢复也受后台 9 次请求预算限制', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const text = decodeURIComponent(init.body.slice(2));
    const trans = text.includes('__JT_') ? 'Broken boundaries.' : text.replace('Source', 'Translated');
    return new Response(JSON.stringify({ sentences: [{ trans }] }), { status: 200 });
  };
  const result = await translate(Array.from({ length: 12 }, (_, i) => item(i + 1)), {
    settings: { ...settings, providerId: 'google-translate' }
  });
  assert.equal(calls, 9);
  assert.equal(result.runtime.translateRequestCount, 9);
  assert.ok(result.items.length > 0);
  assert.ok(result.failed.length > 0);
  assert.equal(result.runtime.recoveredContext, true);
});

test('预检重试保留空响应的 token 用量', async () => {
  const { runPreflight } = await import('../src/background/translator.js');
  const sessionId = 'preflight-usage';
  openSession(sessionId);
  sessions.push(sessionId);
  let calls = 0;
  globalThis.fetch = async () => response(++calls === 1 ? '' : '领域: battery settings');
  const result = await withoutBackoff(() => runPreflight({ digest: 'Battery settings', context, settings, sessionId }));
  assert.equal(calls, 2);
  assert.equal(result.runtime.translateRequestCount, 2);
  assert.deepEqual(result.usage, { input: 20, output: 10 });
  assert.deepEqual(result.runtime.requestReasons, { initial: 1, 'retry:empty-response': 1 });
  assert.equal(result.usageIncomplete, false);
});

test('YAML 预检不强制 JSON，随后翻译仍可以使用 JSON 模式', async () => {
  const requests = [];
  const scoped = { ...settings, apiBase: 'https://preflight-format.invalid/v1' };
  const sessionId = 'preflight-format';
  openSession(sessionId);
  sessions.push(sessionId);
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response(requests.length === 1 ? '领域: Linux' : [{ i: 1, t: 'Result.' }]);
  };
  const profile = await runPreflight({ digest: 'Linux', context, settings: scoped, sessionId });
  const translated = await translate([item(1)], { settings: scoped });
  assert.equal(profile.runtime.translateRequestCount, 1);
  assert.equal(translated.runtime.translateRequestCount, 1);
  assert.equal(requests[0].response_format, undefined);
  assert.deepEqual(requests[1].response_format, { type: 'json_object' });
});

test('限流重试记录实际原因，缺失 usage 保持不完整', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response('private echoed content', { status: 429 }) : response([{ i: 1, t: 'Result.' }]);
  const result = await withoutBackoff(() => translate([item(1)]));
  assert.deepEqual(result.runtime.requestReasons, { initial: 1, 'retry:rate-limit': 1 });
  assert.deepEqual(result.usage, { input: 10, output: 5 });
  assert.equal(result.usageIncomplete, true);
  assert.ok(!JSON.stringify(result.runtime).includes('private'));
});

test('退避期间取消不凭空多记一次重试', async () => {
  const { createExecution } = await import('../src/background/execution.js');
  const { withRetry } = await import('../src/background/queue.js');
  const controller = new AbortController();
  const runtime = { translateRequestCount: 0, splitRetryCount: 0 };
  const execution = createExecution(controller.signal, runtime);
  await assert.rejects(withRetry((_n, previousError) => {
    execution.attempt(0, 'initial', previousError);
    throw Object.assign(new Error('Rate limit'), { status: 429, retryable: true });
  }, { signal: controller.signal, onRetry: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(runtime.translateRequestCount, 1);
  assert.deepEqual(runtime.requestReasons, { initial: 1 });
  assert.equal(execution.usageIncomplete, true);
});

test('预检成功但 provider 未给 usage 时保留未知', async () => {
  const sessionId = 'preflight-unknown-usage';
  openSession(sessionId);
  sessions.push(sessionId);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '领域: Linux' } }] }));
  const result = await runPreflight({ digest: 'Linux', context, settings, sessionId });
  assert.equal(result.usage, null);
  assert.equal(result.usageIncomplete, true);
});

test('两阶段用量只有一个所有者，合计派生且快照不可回写', () => {
  const session = createPageSession();
  session.addUsage({ input: 839, output: 162 }, 'preflight', true);
  session.addUsage({ input: 1701, output: 633 });
  assert.deepEqual(session.tokens, { input: 2540, output: 795, cachedUnits: 0 });
  assert.deepEqual(session.usageByPhase, {
    translate: { input: 1701, output: 633, incomplete: false },
    preflight: { input: 839, output: 162, incomplete: true },
    total: { input: 2540, output: 795, incomplete: true }
  });
  session.usageByPhase.preflight.input = 0;
  assert.equal(session.tokens.input, 2540);
  session.addUsage(null, 'translation', true);
  session.addUsage(null, 'translation', false);
  assert.equal(session.usageByPhase.translate.incomplete, true);
  assert.deepEqual(createPageSession().tokens, { input: 0, output: 0, cachedUnits: 0 });
});

test('失效数值不污染用量，字段缺失仍显式报告不完整', () => {
  const session = createPageSession();
  session.addUsage({ input: Infinity, output: -5 });
  session.addUsage({ input: 10 }, 'preflight');
  assert.deepEqual(session.tokens, { input: 10, output: 0, cachedUnits: 0 });
  assert.equal(session.usageByPhase.translate.incomplete, true);
  assert.equal(session.usageByPhase.preflight.incomplete, true);
  assert.throws(() => session.addUsage({}, '__proto__'));
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`, error); }
  finally { for (const id of sessions.splice(0)) abortSession(id); }
}
await flush();
console.log(failed ? `${failed} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failed ? 1 : 0;
