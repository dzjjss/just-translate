/**
 * 纯译文缓存回归。
 *
 * 缓存不参与页面术语状态：身份只由 provider / endpoint / model / prompt fingerprint / 原文组成，
 * 条目只保存译文与时间。动态 glossary、provenance alias、fixed-point 都不应再出现。
 */
import assert from 'node:assert';

let stored = {
  cache: {
    legacy: { t: '旧译文', g: { fabric: '互连网络' }, ts: Date.now() }
  }
};
global.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in stored ? { [key]: JSON.parse(JSON.stringify(stored[key])) } : {};
      },
      async set(obj) {
        Object.assign(stored, JSON.parse(JSON.stringify(obj)));
      },
      async remove(key) {
        delete stored[key];
      }
    },
    onChanged: { addListener() {} }
  }
};

const { cacheKey, getCached, putCached, initCache, clearCache, flush } = await import('../src/background/cache.js');
const {
  createTranslationCachePolicy,
  canUsePerItemCache,
  wholePageCacheItems,
  lookupWholePageCache
} = await import('../src/background/translator.js');

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const settings = {
  useCache: true,
  providerId: 'openai',
  apiBase: 'https://api.example.com/v1',
  model: 'm'
};

const key = (text, extra = {}) =>
  cacheKey({
    providerId: 'openai',
    endpoint: 'https://api.example.com/v1',
    model: 'm',
    fingerprint: 'fp',
    ...extra,
    text
  });

test('同名模型换端点或 prompt fingerprint 不能互相吃缓存', () => {
  const text = 'Same sentence.';
  assert.notEqual(
    key(text, { endpoint: 'https://api.openai.com/v1' }),
    key(text, { endpoint: 'https://my-gateway.internal/v1' })
  );
  assert.notEqual(key(text), key(text, { fingerprint: 'other-fp' }));
});

test('历史带 g 的条目仍可读译文，但不会恢复任何页面状态', async () => {
  await initCache();
  assert.equal(getCached('legacy'), '旧译文');
  assert.equal(typeof getCached('legacy'), 'string');
});

test('缓存条目只保存译文，不再携带 glossary/provenance', async () => {
  await clearCache();
  putCached('plain', '纯译文');
  assert.equal(getCached('plain'), '纯译文');
  await flush();
  assert.deepEqual(Object.keys(stored.cache.plain).sort(), ['t', 'ts']);
});

test('cache policy 只有查表与写表：命中/未命中不产生额外契约', async () => {
  await clearCache();
  const policy = createTranslationCachePolicy({ settings, fingerprint: 'fp' });
  const items = [
    { i: 1, text: 'Alpha sentence.' },
    { i: 2, text: 'Beta sentence.' }
  ];

  policy.store(items[0].text, '甲。');
  const result = policy.lookup(items);
  assert.equal(result.hits.get(1)?.t, '甲。');
  assert.deepEqual(result.misses.map((x) => x.i), [2]);
  assert.deepEqual(Object.keys(result).sort(), ['hits', 'misses']);
});

test('关闭缓存时 policy 直接全部 miss，也不写入', async () => {
  await clearCache();
  const off = createTranslationCachePolicy({ settings: { ...settings, useCache: false }, fingerprint: 'fp' });
  off.store('A', '甲');
  const result = off.lookup([{ i: 1, text: 'A' }]);
  assert.equal(result.hits.size, 0);
  assert.equal(result.misses.length, 1);
});

test('整页模式禁用逐段缓存，普通分批仍可用', () => {
  assert.equal(canUsePerItemCache(settings, {}), true);
  assert.equal(canUsePerItemCache(settings, { wholePage: true }), false);
  assert.equal(canUsePerItemCache({ ...settings, useCache: false }, {}), false);
});

test('整页缓存身份绑定完整有序快照与单元位置', () => {
  const page = [{ i: 1, text: 'Same.' }, { i: 2, text: 'Same.' }];
  const keys = wholePageCacheItems(page);
  assert.notEqual(keys[0].text, keys[1].text, '同页重复句在不同位置不应共享译文缓存');
  assert.deepEqual(keys, wholePageCacheItems(page), '同一完整快照的缓存身份应稳定');
  assert.notEqual(
    keys[0].text,
    wholePageCacheItems([{ i: 1, text: 'Same.' }, { i: 2, text: 'Changed.' }])[0].text,
    '页面其他位置变化后不能继续复用旧整页缓存'
  );
});

test('整页缓存只接受 100% 命中，部分命中不会挖空下一次全文请求', async () => {
  await clearCache();
  const policy = createTranslationCachePolicy({ settings, fingerprint: 'fp' });
  const page = [{ i: 1, text: 'Alpha.' }, { i: 2, text: 'Beta.' }];
  const virtual = wholePageCacheItems(page);
  policy.store(virtual[0].text, '甲。');
  assert.equal(lookupWholePageCache(policy, page), null, '部分命中必须按整页 miss 处理');
  policy.store(virtual[1].text, '乙。');
  assert.deepEqual(lookupWholePageCache(policy, page), [
    { i: 1, t: '甲。', cached: true },
    { i: 2, t: '乙。', cached: true }
  ]);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
