import assert from 'node:assert';
import { packMachineBatch, parseMachineBatch, translateMachineWithRecovery } from '../src/background/machine-translation.js';
import { googleTranslateWire } from '../src/background/providers/google-translate.js';
import { deepLXWire } from '../src/background/providers/deeplx.js';
import { resolveMachineTarget } from '../src/shared/machine-languages.js';
import { buildMachineContext } from '../src/content/machine-context.js';
import { providerDescriptor } from '../src/shared/provider-catalog.js';
import { isConfigured, toRuntimeConfig } from '../src/shared/settings.js';

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  async json() { return data; }
});

test('机器翻译语言名映射为各自接口代码，未知语言明确报错', () => {
  assert.equal(resolveMachineTarget('简体中文', 'google-translate'), 'zh-CN');
  assert.equal(resolveMachineTarget('简体中文', 'deeplx'), 'ZH');
  assert.equal(resolveMachineTarget('繁體中文', 'deeplx'), 'ZH-HANT');
  assert.equal(resolveMachineTarget('Français', 'deeplx'), 'FR');
  assert.equal(resolveMachineTarget('pt-BR', 'google-translate'), 'pt-BR');
  assert.throws(() => resolveMachineTarget('克林贡语', 'google-translate'), /不认识目标语言/);
});

test('免 Key provider 不要求 Key/模型，并在 runtime 关闭 LLM 专属能力', () => {
  const google = providerDescriptor('google-translate');
  assert.equal(google.kind, 'mt');
  assert.equal(google.requiresKey, false);
  assert.equal(google.requiresModel, false);
  assert.equal(isConfigured({ apiBase: google.defaultBase, apiKey: '', model: '', targetLang: '简体中文' }, google), true);
  const runtime = toRuntimeConfig({
    providerId: google.id,
    apiBase: google.defaultBase,
    model: '',
    targetLang: '简体中文',
    wholePageTranslation: true,
    autoPreflight: true,
    semanticConsistency: true,
    semanticPrecedent: true,
    siteRules: []
  });
  assert.equal(runtime.engineKind, 'mt');
  assert.equal(runtime.autoPreflight, false);
  assert.equal(runtime.semanticConsistency, false);
  assert.equal(runtime.semanticPrecedent, false);
  assert.equal(runtime.wholePageMaxSourceChars, 4500);
  assert.equal(runtime.wholePageMaxItems, 60);
});

test('合并请求能精确回填 ID，并丢弃被翻译的上下文区', () => {
  const items = [{ i: 11, text: 'Power mode' }, { i: 19, text: 'Battery usage' }];
  const packed = packMachineBatch(items, { context: 'Battery settings', nonce: 'case1' });
  const output = packed.text
    .replace('Battery settings', '电池设置')
    .replace('Power mode', '电源模式')
    .replace('Battery usage', '电池用量');
  const parsed = parseMachineBatch(output, items, packed.nonce);
  assert.equal(parsed.missing.length, 0);
  assert.equal(parsed.map.get(11), '电源模式');
  assert.equal(parsed.map.get(19), '电池用量');
  assert.equal([...parsed.map.values()].some((text) => text.includes('电池设置')), false);
});

test('任一边界损坏会丢弃整批结果并二分到裸文本，不把串段译文展示给用户', async () => {
  const items = [{ i: 1, text: 'Alpha' }, { i: 2, text: 'Beta' }];
  const calls = [];
  const runtime = { boundaryRecoveryCount: 0 };
  const result = await translateMachineWithRecovery({
    items,
    context: 'Document title',
    runtime,
    async request(text, depth) {
      calls.push({ text, depth });
      if (depth === 0) return text.replace(/UNIT_1__/, 'BROKEN__').replace('Alpha', '甲').replace('Beta', '乙');
      return `译:${text}`;
    }
  });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.items.map((item) => [item.i, item.t]), [[1, '译:Alpha'], [2, '译:Beta']]);
  assert.equal(runtime.boundaryRecoveryCount, 1);
  assert.equal(calls.length, 3);
});

test('分块邻接语境只取标题、章节与前后单元，并受字符上限约束', () => {
  const units = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, text: `段落 ${index + 1}` }));
  const context = buildMachineContext({
    units,
    chunk: units.slice(2, 4),
    title: '电池支持',
    sectionPath: '电池 > 每日用量',
    maxChars: 90
  });
  assert.ok(context.includes('Title: 电池支持'));
  assert.ok(context.includes('Before: 段落 2'));
  assert.ok(context.includes('After: 段落 5'));
  assert.equal(context.includes('Before: 段落 3'), false, '当前批正文不该重复塞进 context');
  assert.ok(context.length <= 90);
});

test('Google Translate wire 使用 POST 并合并 sentences', async () => {
  const original = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ src: 'en', sentences: [{ trans: '你' }, { trans: '好' }] });
  };
  try {
    const result = await googleTranslateWire.translate({
      base: 'https://translate.googleapis.com', text: 'Hello', targetLang: 'zh-CN'
    });
    assert.equal(result.text, '你好');
    assert.equal(request.options.method, 'POST');
    assert.ok(request.url.includes('client=gtx'));
    assert.ok(request.options.body.includes('q=Hello'));
  } finally {
    global.fetch = original;
  }
});

test('DeepLX wire 向完整端点发送兼容 JSON', async () => {
  const original = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ code: 200, data: '你好' });
  };
  try {
    const result = await deepLXWire.translate({
      base: 'http://localhost:1188/translate', text: 'Hello', targetLang: 'ZH'
    });
    assert.equal(result.text, '你好');
    assert.equal(request.url, 'http://localhost:1188/translate');
    assert.deepEqual(JSON.parse(request.options.body), {
      text: 'Hello', source_lang: 'AUTO', target_lang: 'ZH'
    });
  } finally {
    global.fetch = original;
  }
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (error) {
    failed++;
    console.error('  ✗', name, '\n   ', error.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
