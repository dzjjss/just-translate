import assert from 'node:assert/strict';
let stored = {};
globalThis.chrome = { storage: { local: {
  async get(key) { return structuredClone({ [key]: stored[key] }); },
  async set(value) { Object.assign(stored, structuredClone(value)); },
  async remove(key) { delete stored[key]; }
}, onChanged: { addListener() {} } } };
const { runPreflight, openSession, abortSession } = await import('../src/background/translator.js');
const { cacheGeneration, clearCache, putCached, flush } = await import('../src/background/cache.js');
const { preflightCacheKey, readPreflightCache, writePreflightCache, beginPreflightCache } = await import('../src/background/preflight-cache.js');
const settings = { providerId: 'openai', apiBase: 'https://mock.invalid/v1', model: 'test',
  apiKey: 'fixture', targetLang: 'English', useCache: true };
const args = { settings, identity: 'complete-content-identity', digest: '电池健康',
  context: { title: 'Battery guide', hostname: 'example.test' }, sessionId: 'preflight-test' };
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  return new Response(JSON.stringify({ choices: [{ message: { content: '领域: battery\n优先:\n  电池健康: Battery Health' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }));
};
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
test('相同身份复用，显式刷新和关闭缓存均发新请求', async () => {
  openSession(args.sessionId);
  const first = await runPreflight(args);
  assert.equal(first.reused, false);
  assert.ok(Object.keys(stored.cache).some(key => key.startsWith('preflight:')));
  assert.equal((await runPreflight(args)).reused, true);
  assert.equal(requests, 1);
  assert.equal((await runPreflight({ ...args, force: true })).reused, false);
  assert.equal((await runPreflight({ ...args, settings: { ...settings, useCache: false } })).reused, false);
  assert.equal(requests, 3);
});
test('完整正文、目标语言、供应商端点、模型和标题分别隔离', () => {
  const key = preflightCacheKey(args);
  const changes = [
    { identity: 'changed-unsampled-tail' }, { digest: '新正文' },
    { settings: { ...settings, targetLang: 'French' } },
    { settings: { ...settings, apiBase: 'https://other.invalid/v1' } },
    { settings: { ...settings, model: 'other' } },
    { settings: { ...settings, providerId: 'deepseek' } },
    { settings: { ...settings, customPrompt: 'Use formal wording.' } },
    { settings: { ...settings, rulesText: '优先:\n  battery: 电池' } },
    { context: { ...args.context, title: 'Other title' } }
  ];
  for (const change of changes) assert.notEqual(preflightCacheKey({ ...args, ...change }), key);
  assert.equal(preflightCacheKey({ ...args, settings: { ...settings, displayMode: 'translation', configVersion: 55 } }), key);
});
test('没有完整正文身份时不复用摘要缓存', () => {
  assert.equal(preflightCacheKey({ ...args, identity: undefined }), null);
  assert.equal(preflightCacheKey({ ...args, identity: 'a'.repeat(129) }), null);
});
test('过期、未来时间、损坏和过大的记录都作未命中处理', () => {
  const key = preflightCacheKey(args);
  for (const raw of ['broken', 'x'.repeat(16001), JSON.stringify({ createdAt: 0, profile: {} }),
    JSON.stringify({ createdAt: Date.now() + 60000, profile: {} }),
    JSON.stringify({ createdAt: Date.now(), profile: [] })]) {
    putCached(key, raw);
    assert.equal(readPreflightCache(key), null);
  }
});
test('清空后的迟到预检不能重新写入旧缓存', async () => {
  const generation = cacheGeneration();
  await clearCache();
  const key = preflightCacheKey(args);
  writePreflightCache(key, { domain: ['battery'] }, generation);
  assert.equal(readPreflightCache(key), null);
});
test('画像记录数量有上限，单条过大不写入', async () => {
  await clearCache();
  for (let i = 0; i < 135; i++) writePreflightCache(`preflight:v1:${i}`, { domain: ['battery'] }, cacheGeneration());
  await flush();
  assert.equal(Object.keys(stored.cache).filter(key => key.startsWith('preflight:')).length, 128);
  writePreflightCache('preflight:v1:oversized', { preferred: { term: 'x'.repeat(20000) } }, cacheGeneration());
  assert.equal(readPreflightCache('preflight:v1:oversized'), null);
});
test('取消会话后不能从缓存取画像绕过生命周期检查', async () => {
  abortSession(args.sessionId);
  await assert.rejects(runPreflight(args), { name: 'AbortError' });
});
test('连续强制预检按发起顺序确定所有权，迟到旧结果不覆盖新画像', async () => {
  await clearCache();
  const key = preflightCacheKey(args);
  const generation = cacheGeneration();
  const first = beginPreflightCache(key);
  const second = beginPreflightCache(key);
  writePreflightCache(key, { domain: ['old'] }, generation, first);
  assert.equal(readPreflightCache(key), null);
  writePreflightCache(key, { domain: ['new'] }, generation, second);
  writePreflightCache(key, { domain: ['late-old'] }, generation, first);
  assert.deepEqual(readPreflightCache(key).profile.domain, ['new']);
});
test('强制刷新失败不会删除上一份有效画像', () => {
  const key = preflightCacheKey(args);
  beginPreflightCache(key);
  assert.deepEqual(readPreflightCache(key).profile.domain, ['new']);
});

let failures = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('  ✓', name); }
  catch (error) { failures++; console.error('  ✗', name, error); }
}
await clearCache(); await flush();
console.log(failures ? `${failures} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failures ? 1 : 0;
