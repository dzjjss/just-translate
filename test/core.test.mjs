/** 纯逻辑核心回归：不依赖 DOM/jsdom，CI 最先跑。 */
import assert from 'node:assert';
import { createPageSession } from '../src/content/session.js';
import { createTranslationScheduler, decideTranslationMode } from '../src/content/translation-scheduler.js';
import { resolvePageContext } from '../src/content/page-context.js';
import { buildPlainDigest } from '../src/content/digest.js';
import { buildMessages, buildPreflightMessages, promptFingerprint } from '../src/prompt/build.js';
import { PROVIDER_PRESETS } from '../src/shared/provider-catalog.js';
import { softenAutoRules } from '../src/shared/rules-yaml.js';
import {
  classifyRuntimeConfigChange,
  semanticRevision,
  toRuntimeConfig
} from '../src/shared/settings.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('runtime contract：私有模型设置只通过 opaque semanticRevision 下发', () => {
  const base = {
    providerId: 'openai', apiBase: 'https://api.openai.com/v1', model: 'gpt-a', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '',
    autoPreflight: true, siteRules: [], smartFilter: true, maxCharsPerChunk: 2800,
    translationStyle: 'bar'
  };
  const runtime = toRuntimeConfig(base);
  assert.ok(runtime.semanticRevision);
  assert.equal('model' in runtime, false, 'model 不该暴露给 content');
  assert.equal('apiBase' in runtime, false, 'endpoint 不该暴露给 content');
  assert.equal('customPrompt' in runtime, false, 'custom prompt 不该暴露给 content');

  const changed = toRuntimeConfig({ ...base, model: 'gpt-b' });
  assert.notEqual(runtime.semanticRevision, changed.semanticRevision, '换模型却没有改变语义版本');
  assert.equal(classifyRuntimeConfigChange(runtime, changed).semantic, true);
});

test('runtime contract：呈现/提取/调度变化不会误报成语义变化', () => {
  const baseSettings = {
    providerId: 'openai', apiBase: 'x', model: 'm', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '', autoPreflight: true,
    siteRules: [], smartFilter: true, maxCharsPerChunk: 2800, translationStyle: 'bar'
  };
  const base = toRuntimeConfig(baseSettings);

  const presentation = { ...base, translationStyle: 'tint' };
  const p = classifyRuntimeConfigChange(base, presentation);
  assert.equal(p.semantic, false);
  assert.deepEqual(p.presentation, ['translationStyle']);

  const extraction = { ...base, smartFilter: false };
  const e = classifyRuntimeConfigChange(base, extraction);
  assert.equal(e.semantic, false);
  assert.deepEqual(e.extraction, ['smartFilter']);

  const scheduling = { ...base, maxCharsPerChunk: 1200 };
  const q = classifyRuntimeConfigChange(base, scheduling);
  assert.equal(q.semantic, false);
  assert.deepEqual(q.scheduling, ['maxCharsPerChunk']);
});

test('runtime contract：整页优先策略下发到 content，切换时整页重启', () => {
  const baseSettings = {
    providerId: 'openai', apiBase: 'x', model: 'm', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '', autoPreflight: true,
    siteRules: [], wholePageTranslation: false
  };
  const chunked = toRuntimeConfig(baseSettings);
  const whole = toRuntimeConfig({ ...baseSettings, wholePageTranslation: true });
  assert.equal(chunked.wholePageTranslation, false);
  assert.equal(whole.wholePageTranslation, true);
  assert.notEqual(chunked.semanticRevision, whole.semanticRevision);
  assert.equal(classifyRuntimeConfigChange(chunked, whole).semantic, true);
});

test('runtime contract：纯观测与 precedent 注入分权', () => {
  const baseSettings = {
    providerId: 'openai', apiBase: 'x', model: 'm', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '', autoPreflight: true,
    siteRules: [], semanticConsistency: true, semanticPrecedent: false
  };
  const base = toRuntimeConfig(baseSettings);
  const observation = toRuntimeConfig({ ...baseSettings, semanticConsistency: false });
  assert.equal(base.semanticRevision, observation.semanticRevision, '纯观测开关不应改变 prompt 版本');
  assert.deepEqual(classifyRuntimeConfigChange(base, observation).observation, ['semanticConsistency']);

  const precedent = toRuntimeConfig({ ...baseSettings, semanticPrecedent: true });
  assert.notEqual(base.semanticRevision, precedent.semanticRevision, 'precedent 会改变 prompt，必须进入语义版本');
  assert.equal(classifyRuntimeConfigChange(base, precedent).semantic, true);
});

test('runtime contract：站点 selector 只算提取变化，站点 prompt 才算语义变化', () => {
  const baseSettings = {
    providerId: 'openai', apiBase: 'x', model: 'm', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '', autoPreflight: true,
    siteRules: [{ host: 'docs.example.com', selectors: '.old', rulesText: '锁定:\n  fabric: 互连网络' }]
  };
  const base = toRuntimeConfig(baseSettings);

  const selectorOnly = toRuntimeConfig({
    ...baseSettings,
    siteRules: [{ ...baseSettings.siteRules[0], selectors: '.new' }]
  });
  const e = classifyRuntimeConfigChange(base, selectorOnly);
  assert.equal(e.semantic, false, '只改 selector 不该重翻整页');
  assert.deepEqual(e.extraction, ['siteRules']);

  const semantic = toRuntimeConfig({
    ...baseSettings,
    siteRules: [{ ...baseSettings.siteRules[0], rulesText: '锁定:\n  fabric: 结构' }]
  });
  assert.equal(classifyRuntimeConfigChange(base, semantic).semantic, true);
});

test('runtime contract：旧配置没有 semanticRevision 时，接入新契约必须视为语义变化', () => {
  const legacy = { targetLang: '简体中文', smartFilter: true };
  const current = { ...legacy, semanticRevision: 'rev-1' };
  assert.equal(classifyRuntimeConfigChange(legacy, current).semantic, true);
});


test('PageContext：站点 selector 是派生快照，不得反写全局 runtime config', () => {
  const runtime = {
    presetId: 'auto', background: '', rulesText: '', skipSelectors: '.global',
    siteRules: [{ host: 'docs.example.com', selectors: '.site' }]
  };
  const pageA = resolvePageContext(runtime, { hostname: 'docs.example.com', title: 'A', url: 'https://docs.example.com/a' });
  assert.equal(pageA.pageConfig.skipSelectors, '.global, .site');
  assert.equal(runtime.skipSelectors, '.global', '派生站点规则污染了全局 runtime config');

  const pageB = resolvePageContext(runtime, { hostname: 'other.example.com', title: 'B', url: 'https://other.example.com/b' });
  assert.equal(pageB.pageConfig.skipSelectors, '.global', '离开站点后旧 selector 仍然残留');
});

test('PageSession：旧 gate 的 finally 不能清掉后来建立的新 gate', async () => {
  const session = createPageSession();
  const a = deferred();
  const b = deferred();
  const gateA = session.beginGate(() => a.promise);
  const gateB = session.beginGate(() => b.promise);
  assert.equal(session.gate, gateB);

  a.resolve('old');
  await gateA;
  assert.equal(session.gate, gateB, '旧 gate 完成后把新 gate 清掉了');

  b.resolve('new');
  await gateB;
  assert.equal(session.gate, null);
});

test('PageSession：同一页旧 preflight token 不能覆盖后来一次预检', () => {
  const session = createPageSession();
  const old = session.beginPreflight();
  const fresh = session.beginPreflight();
  assert.equal(old.isCurrent(), false);
  assert.equal(fresh.isCurrent(), true);
  session.clearProfile();
  assert.equal(fresh.isCurrent(), false, '清画像后旧 preflight 仍有写权限');
});

test('PageSession：等待 gate 时如果被新 gate 替换，必须继续等新的', async () => {
  const session = createPageSession();
  const a = deferred();
  const b = deferred();
  session.beginGate(() => a.promise);
  let released = false;
  const waiting = session.waitForGate().then(() => { released = true; });

  session.beginGate(() => b.promise);
  a.resolve();
  await tick(0);
  assert.equal(released, false, '旧 gate 返回后绕过了后来建立的新 gate');

  b.resolve();
  await waiting;
  assert.equal(released, true);
});

test('Scheduler：第一批未返回前，后续 enqueue 不得启动第二个“第一批”', async () => {
  const session = createPageSession();
  const first = deferred();
  const calls = [];
  const scheduler = createTranslationScheduler({
    session,
    maxChars: 6,
    send: async (_session, chunk) => {
      calls.push(chunk.map((u) => u.id));
      if (calls.length === 1) await first.promise;
    }
  });

  scheduler.enqueue([
    { id: 1, text: 'abcdefgh' },
    { id: 2, text: 'ijklmnop' },
    { id: 3, text: 'qrstuvwx' }
  ]);
  await tick(180);
  assert.equal(calls.length, 1, `第一批未返回却已经发了 ${calls.length} 批`);

  scheduler.enqueue([{ id: 4, text: 'yzabcdef' }]);
  await tick(180);
  assert.equal(calls.length, 1, '重入 drain 又启动了一批');

  first.resolve();
  await tick(80);
  await scheduler.flush();
  await tick(20);
  assert.ok(calls.length >= 4, '第一批完成后剩余批次没有继续执行');
  scheduler.stop();
});

test('Scheduler：session 失效后旧 drain 不得继续发送剩余 chunks', async () => {
  const session = createPageSession();
  const first = deferred();
  const calls = [];
  const scheduler = createTranslationScheduler({
    session,
    maxChars: 6,
    send: async (_session, chunk) => {
      calls.push(chunk.map((u) => u.id));
      if (calls.length === 1) await first.promise;
    }
  });
  scheduler.enqueue([
    { id: 1, text: 'abcdefgh' },
    { id: 2, text: 'ijklmnop' },
    { id: 3, text: 'qrstuvwx' }
  ]);
  await tick(180);
  assert.equal(calls.length, 1);
  session.invalidate();
  first.resolve();
  await tick(80);
  assert.deepEqual(calls, [[1]], '旧 session 失效后仍继续发送旧 chunks');
  assert.equal(scheduler.inflight, 0, '旧请求 finally 把 inflight 留在错误状态');
});

test('Scheduler：优先级为真的段先出队，且每次取批时现算', async () => {
  const session = createPageSession();
  const calls = [];
  let near = new Set([3]);
  const scheduler = createTranslationScheduler({
    session,
    maxChars: 6,
    priority: (u) => near.has(u.id),
    send: async (_session, chunk) => {
      calls.push(chunk.map((u) => u.id));
      // 模拟第一批在途时用户滚动到了别处
      if (calls.length === 1) near = new Set([4]);
    }
  });
  scheduler.enqueue([
    { id: 1, text: 'abcdefgh' },
    { id: 2, text: 'ijklmnop' },
    { id: 3, text: 'qrstuvwx' },
    { id: 4, text: 'yzabcdef' }
  ]);
  await tick(180);
  await scheduler.flush();
  await tick(20);
  assert.deepEqual(calls[0], [3], '初始视口附近的段没有成为第一批');
  assert.deepEqual(calls[1], [4], '滚动后的新视口没有插到文档序前面');
  assert.equal(calls.length, 4, '剩余段落没有全部翻完');
  scheduler.stop();
});

test('Scheduler：安全范围内整页优先绕过分块与视口优先，只发一个有序批次', async () => {
  const session = createPageSession();
  const calls = [];
  const scheduler = createTranslationScheduler({
    session,
    maxChars: 1,
    wholePage: true,
    priority: (u) => u.id === 24,
    send: async (_session, chunk, options) => {
      calls.push({ ids: chunk.map((u) => u.id), options });
    }
  });
  scheduler.enqueue(
    Array.from({ length: 24 }, (_, i) => ({ id: i + 1, text: `sentence-${i + 1}` }))
  );
  await scheduler.flush();
  assert.equal(calls.length, 1, `整页模式仍拆成了 ${calls.length} 个请求`);
  assert.deepEqual(calls[0].ids, Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(calls[0].options.wholePage, true);

  await scheduler.sendNow([{ id: 99, text: 'manual retry' }], { bypassCache: true });
  assert.equal(calls[1].options.wholePage, undefined, '手动单段重翻伪装成了整页请求');
  assert.equal(calls[1].options.bypassCache, true);
  scheduler.stop();
});

test('Scheduler：整页触发器按字符数、条数与手动开关确定性降级', () => {
  const small = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, text: 'a'.repeat(100) }));
  assert.deepEqual(
    decideTranslationMode(small),
    {
      translationMode: 'whole-page', modeReason: 'within-safe-range', sourceChars: 2000,
      unitCount: 20, maxSourceChars: 12000, maxItems: 80
    }
  );
  assert.equal(decideTranslationMode([{ text: 'a'.repeat(12001) }]).modeReason, 'source-char-limit');
  assert.equal(decideTranslationMode(Array.from({ length: 81 }, () => ({ text: 'a' }))).modeReason, 'unit-count-limit');
  assert.equal(decideTranslationMode(small, { preferWholePage: false }).modeReason, 'user-disabled');
});

test('semanticRevision 对对象键序稳定', () => {
  const a = semanticRevision({ providerId: 'x', model: 'm', siteRules: [{ host: 'a', auto: true }] });
  const b = semanticRevision({ model: 'm', providerId: 'x', siteRules: [{ auto: true, host: 'a' }] });
  assert.equal(a, b);
});


test('Prompt 输入使用 YAML，而翻译输出合同仍明确要求 JSON', () => {
  const built = buildMessages({
    items: [{ i: 1, text: 'Open Settings and tap Power Mode.' }],
    context: { title: 'Battery', hostname: 'support.example.com' },
    presetId: 'general', targetLang: '简体中文', customPrompt: '', background: '', profile: null,
    trackedTerms: ['Power'], semanticMemory: [{ term: 'Power', trigger: 'tap power mode', target: '电源' }]
  });
  assert.ok(built.user.startsWith('page:\n'), 'user payload 仍然是 JSON');
  assert.ok(built.user.includes('items:\n'));
  assert.equal(built.user.trim().startsWith('{'), false);
  assert.ok(built.system.includes('Reply with ONE JSON object'), '响应合同不该跟着改成 YAML');
  assert.ok(built.system.includes('exact_local_trigger'));

  const preflight = buildPreflightMessages({ digest: 'Battery help', context: { title: 'Battery' }, targetLang: '简体中文' });
  assert.ok(preflight.user.startsWith('page:\n'));
});

test('semantic memory 进入 cache fingerprint，避免 scoped hint 变化仍吃旧译文', () => {
  const base = { presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '', profile: null };
  const a = promptFingerprint({ ...base, semanticMemory: [{ term: 'power', trigger: 'battery power', target: '电量' }] });
  const b = promptFingerprint({ ...base, semanticMemory: [{ term: 'power', trigger: 'power mode', target: '电源' }] });
  assert.notEqual(a, b);
});

test('整页模式有显式全文指令，并与普通分批缓存身份隔离', () => {
  const base = {
    presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '', profile: null
  };
  const built = buildMessages({
    ...base,
    wholePage: true,
    items: [{ i: 1, text: 'Power is limited.' }, { i: 2, text: 'Political power shifted.' }]
  });
  assert.ok(built.system.includes('WHOLE-PAGE TRANSLATION BATCH'));
  assert.ok(built.system.includes('same sense and role'));
  assert.ok(built.system.includes('document-wide choice'));
  assert.notEqual(promptFingerprint(base), promptFingerprint({ ...base, wholePage: true }));
});

test('cache fingerprint：实际 sampling 行为必须进入身份', () => {
  const base = {
    presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '', profile: null
  };
  const normal = promptFingerprint({ ...base, temperature: 0.2 });
  assert.notEqual(normal, promptFingerprint({ ...base, temperature: null }));
  assert.notEqual(normal, promptFingerprint({ ...base, temperature: 0.5 }));
});

test('digest：结构采样后也必须严格守住字符预算', () => {
  const units = [
    { text: 'H'.repeat(2000), role: 'heading', tag: 'H1' },
    { text: 'P'.repeat(2000), role: 'text', tag: 'P' }
  ];
  const digest = buildPlainDigest(units, { budget: 300 });
  assert.equal(digest.sampled, true);
  assert.ok(digest.text.length <= 300, `摘要 ${digest.text.length} 字，超过 300 字硬预算`);
  assert.equal(digest.chars, digest.text.length, 'chars 应该反映真正送给模型的字符数');
});

test('provider catalog：Gemini 默认模型不再指向已退役的 2.0 系列', () => {
  const gemini = PROVIDER_PRESETS.find((p) => p.id === 'gemini');
  assert.equal(gemini?.defaultModel, 'gemini-3.7-flash');
  assert.equal(gemini?.omitTemperature, true);
  assert.ok(!(gemini?.models || []).some((m) => m.startsWith('gemini-2.0')));
});


test('自动预检只保留 domain / preferred / risky：旧 hard 降级，principle / keep 清空', () => {
  const softened = softenAutoRules({ principle: '保持功能名原文', hard: { WiFi: '无线局域网', power: '电量' }, preferred: { Battery: '电池' }, risky: { power: 'energy usage' }, keep: ['Adaptive Power'] });
  assert.deepEqual(softened.hard, {});
  assert.equal(softened.principle, '');
  assert.deepEqual(softened.keep, []);
  assert.equal(softened.preferred.WiFi, '无线局域网');
  assert.equal(softened.preferred.Battery, '电池');
  assert.equal('power' in softened.preferred, false, '风险词不能同时获得全局 target suggestion');
  const preflight = buildPreflightMessages({ digest: 'Battery help', context: { title: 'Battery' }, targetLang: '简体中文' });
  assert.ok(!preflight.system.includes('锁定:'), '自动预检不该再向模型索取 hard/locked 术语');
  assert.ok(!preflight.system.includes('\n原则:'), '自动预检不该再产出 page principle');
  assert.ok(!preflight.system.includes('\n不翻:'), '自动预检不该再产出 keep 列表');
  assert.ok(preflight.system.includes('suggestion list'));
});


test('自动预检术语建议与用户 preferred/hard 分权，并进入 cache fingerprint', () => {
  const msg = buildMessages({
    items: [{ i: 1, text: 'One of the Martian giants returned.' }],
    context: {}, presetId: 'general', targetLang: '简体中文', customPrompt: '', background: '',
    profile: { hard: { Ogilvy: '奥吉尔维' }, preferred: { cylinder: '圆筒' } },
    preflightSuggestions: { Martian: '火星人' }
  });
  assert.ok(msg.system.includes('LOCKED TERMS'));
  assert.ok(msg.system.includes('PREFERRED TERMS'));
  assert.ok(msg.system.includes('PREFLIGHT TERM SUGGESTIONS'));
  assert.ok(msg.system.includes('same sense and grammatical role'));

  const base = { presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '', profile: null };
  assert.notEqual(
    promptFingerprint(base),
    promptFingerprint({ ...base, preflightSuggestions: { Martian: '火星人' } }),
    '预检建议改变实际 prompt，必须改变缓存身份'
  );
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.stack || e.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
