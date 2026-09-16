/**
 * 内容脚本集成测试。
 *
 * main.js 是整个项目里状态最多的一块（预检、闸门、画像、术语、增量扫描），
 * 却一直只靠 node --check 兜着 —— 时序类 bug 正是从这个缺口漏进去的：
 * 翻译请求先于预检发出、SPA 换页后旧画像继续生效，两个都是真实踩到的。
 *
 *   npm i -D jsdom && node test/content.test.mjs
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<body><article>
  <h1>Wayland display protocol</h1>
  <p>Wayland is a display server protocol used by modern Linux desktops.</p>
  <p>Compositors implement the protocol and manage surfaces for clients.</p>
  <p>Xwayland provides compatibility for native X11 applications.</p>
</article></body>`;

const dom = new JSDOM(PAGE, { url: 'https://wiki.example.org/wayland' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.location = dom.window.location;
global.MutationObserver = dom.window.MutationObserver;

// jsdom 没有 matchMedia，补最小实现
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.matchMedia = dom.window.matchMedia;

/* ------------------------------ chrome 桩 ------------------------------ */

const calls = [];
let listener = null;
let preflightDelay = 60;
let preflightProfile = {
  principle: '保持界面路径和功能名称原文',
  domain: ['Linux'],
  hard: { compositor: '合成器' },
  risky: ['output'],
  keep: ['Adaptive Power']
};
let chunkPrefix = '【译】';
let nextPreflightGate = null;
let nextPreflightResponse = null;
let nextChunkGate = null;
let nextChunkResponse = null;
const initialConfigGate = deferred();
let getConfigGate = initialConfigGate;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const chrome = {
  runtime: {
    async sendMessage(msg) {
      calls.push({ type: msg.type, at: Date.now(), payload: msg.payload });
      if (msg.type === 'preflight') {
        const profile = JSON.parse(JSON.stringify(preflightProfile));
        const gate = nextPreflightGate;
        nextPreflightGate = null;
        if (gate) await gate.promise;
        else await tick(preflightDelay);
        const forced = nextPreflightResponse;
        nextPreflightResponse = null;
        return forced || { ok: true, profile, usage: { input: 100, output: 20 } };
      }
      if (msg.type === 'abort-session') return { ok: true };
      if (msg.type === 'translate-chunk') {
        const prefix = chunkPrefix;
        const gate = nextChunkGate;
        nextChunkGate = null;
        if (gate) await gate.promise;
        const forced = nextChunkResponse;
        nextChunkResponse = null;
        if (forced) return typeof forced === 'function' ? forced(msg) : forced;
        return {
          ok: true,
          items: (msg.payload.items || []).map((it) => ({ i: it.i, t: prefix + it.text.slice(0, 8) })),
          failed: [],
          runtime: { translateRequestCount: 1, splitRetryCount: 0, wholePageCacheHit: false }
        };
      }
      if (msg.type === 'get-config') {
        const gate = getConfigGate;
        getConfigGate = null;
        if (gate) await gate.promise;
        return { ok: true, config: { floatButton: true, floatPosition: 'bottom', floatOffset: 0, siteRules: [], debug: false } };
      }
      return { ok: true };
    },
    onMessage: {
      addListener(fn) {
        listener = fn;
      }
    }
  }
};
global.chrome = chrome;

await import(resolve(here, '../src/content/main.js'));
assert.ok(listener, '内容脚本没有注册消息监听');
// 故意不放行 GET_CONFIG：悬浮球必须靠页面侧打包默认值先出现，不能等 MV3 SW 冷启动。
assert.ok(document.querySelector('#byom-fab'), '后台尚未回复时悬浮球没有立即出现');
initialConfigGate.resolve();
await tick(10);

const CONFIG = {
  targetLang: '简体中文',
  semanticRevision: 'sem-a',
  presetId: 'auto',
  background: '',
  rulesText: '',
  maxCharsPerChunk: 2800,
  maxItemsPerChunk: 20,
  minTextLength: 2,
  skipSameScript: true,
  skipSingleToken: true,
  skipTightLayout: false,
  skipSelectors: '',
  siteRules: [],
  autoPreflight: true,
  wholePageTranslation: false,
  floatButton: false,
  translationStyle: 'bar',
  debug: false
};

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    const ret = listener({ type, payload }, {}, resolve);
    if (ret !== true) resolve();
  });

const chunkCalls = () => calls.filter((c) => c.type === 'translate-chunk');
const preflightCalls = () => calls.filter((c) => c.type === 'preflight');

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* -------------------------------- 用例 -------------------------------- */

test('bootstrap 不等待后台配置也会先显示悬浮球', () => {
  assert.ok(document.querySelector('#byom-fab'), '静态内容脚本自举后悬浮球没有首次出现');
});

test('预检先于任何翻译请求完成，且每一批都带上画像', async () => {
  calls.length = 0;
  await send('start', { config: CONFIG });
  await tick(20);

  // 预检还在飞的时候，占位节点应该已经出现了（用户看得到反应）
  assert.ok(document.querySelector('.byom-t'), '预检期间没有插入占位节点');
  assert.equal(chunkCalls().length, 0, '预检还没回来就把翻译请求发出去了');

  await tick(200);
  assert.equal(preflightCalls().length, 1, '应当恰好预检一次');
  assert.ok(chunkCalls().length > 0, '预检完成后没有发出翻译请求');

  const pf = preflightCalls()[0];
  for (const c of chunkCalls()) {
    assert.ok(c.at >= pf.at, '翻译请求早于预检发出');
    assert.ok(c.payload.context.profile, '请求里没有带画像');
    assert.equal(c.payload.context.preflightSuggestions.compositor, '合成器');
    assert.equal(c.payload.context.profile.principle, '', '自动 principle 仍然能改变译文');
    assert.deepEqual(c.payload.context.profile.keep, [], '自动 keep 仍然能留下英文原文');
    assert.deepEqual(c.payload.context.profile.hard, {}, '自动 hard 仍保留了强制权限');
  }
});

test('译文已回填到页面', () => {
  const nodes = [...document.querySelectorAll('.byom-t')];
  assert.ok(nodes.length >= 3, `译文节点太少：${nodes.length}`);
  assert.ok(nodes.some((n) => n.textContent.startsWith('【译】')), '译文没有写进节点');
});

test('SPA 换文章后旧画像作废，会为新页面重新预检', async () => {
  calls.length = 0;
  preflightProfile = { domain: ['法律'], hard: { article: '编' }, risky: [] };

  // 模拟单页应用换路由：地址与正文都变了
  dom.reconfigure({ url: 'https://wiki.example.org/ucc-9-312' });
  document.querySelector('article').innerHTML =
    '<h1>Perfection of security interests</h1>' +
    '<p>A security interest in chattel paper may be perfected by filing.</p>';

  await tick(700); // 等 MutationObserver 去抖 + 重新扫描
  assert.equal(preflightCalls().length, 1, '换页后应当重新预检一次');

  const fresh = chunkCalls();
  assert.ok(fresh.length > 0, '新内容没有被翻译');
  for (const c of fresh) {
    assert.ok(!c.payload.context.preflightSuggestions?.compositor, '上一篇的画像被带到了新文章');
    assert.equal(c.payload.context.preflightSuggestions?.article, '编', '新画像没有生效');
  }
});

test('清除译文会同时作废画像，下次翻译重新预检', async () => {
  await send('clear-page');
  assert.equal(document.querySelectorAll('.byom-t').length, 0, '译文节点没有清干净');

  calls.length = 0;
  await send('start', { config: CONFIG });
  await tick(200);
  assert.equal(preflightCalls().length, 1, '清除后重新翻译应当重新预检，而不是沿用旧画像');
});

test('预检的 token 也计入用量', async () => {
  await send('clear-page');
  calls.length = 0;
  await send('start', { config: CONFIG });
  await tick(400);
  const state = await send('get-state');
  assert.ok(state.tokens.input >= 100, `预检的 100 input token 没有计入，当前 ${state.tokens.input}`);
});

test('翻译快照不混入预检 token，诊断同时给出两阶段和全页总量', async () => {
  await send('clear-page');
  document.querySelector('article').innerHTML = '<p>Wayland encodes and decodes messages.</p>';
  nextPreflightResponse = {
    ok: true, profile: { domain: ['Wayland'], risky: { 'encoding/decoding': 'serialization' } },
    usage: { input: 839, output: 162 }, usageIncomplete: true,
    runtime: { translateRequestCount: 2, requestReasons: { initial: 1, 'retry:rate-limit': 1 } }
  };
  nextChunkResponse = msg => ({
    ok: true, items: msg.payload.items.map(item => ({ i: item.i, t: 'Wayland 对消息进行编码和解码。' })),
    failed: [], usage: { input: 1701, output: 633 }, usageIncomplete: false,
    runtime: { translateRequestCount: 1, requestReasons: { initial: 1 } }
  });
  await send('start', { config: { ...CONFIG, wholePageTranslation: true, semanticConsistency: true } });
  await tick(300);
  const state = await send('get-state');
  assert.deepEqual(state.tokens, { input: 2540, output: 795, cachedUnits: 0 });
  assert.deepEqual(state.translationRuntime.tokens, { input: 1701, output: 633 });
  assert.equal(state.translationRuntime.usageIncomplete, false);
  const runtime = state.consistencyTelemetry.runtime;
  assert.deepEqual(runtime.translation.tokens, state.translationRuntime.tokens);
  assert.deepEqual(runtime.preflight.sourceCoverage.risky.unmatched, ['encoding/decoding']);
  assert.equal(runtime.preflight.sourceCoverage.risky.matched, 0);
  const diagnostic = (await send('get-diagnostics')).diagnostic;
  assert.deepEqual(diagnostic.usageByPhase, {
    translate: { input: 1701, output: 633, incomplete: false },
    preflight: { input: 839, output: 162, incomplete: true },
    total: { input: 2540, output: 795, incomplete: true }
  });
  const profileEvent = diagnostic.events.find(row => row.event === 'preflight-result');
  assert.deepEqual(profileEvent.details.runtime.requestReasons, { initial: 1, 'retry:rate-limit': 1 });
  assert.equal(profileEvent.details.usageIncomplete, true);
  assert.ok(!JSON.stringify(diagnostic).includes('serialization'), '诊断不能携带词义或正文');
});

test('广播快照带上大纲，面板开着时不会看到空树', async () => {
  await send('clear-page');
  calls.length = 0;
  preflightProfile = { domain: ['Linux'], hard: { compositor: '合成器' }, preferred: {}, risky: {}, keep: [] };
  await send('start', { config: CONFIG });
  await tick(300);

  const states = calls.filter((c) => c.type === 'tab-state');
  assert.ok(states.length, '没有广播状态');
  const withOutline = states.filter((c) => (c.payload.profileYaml || '').includes('compositor'));
  assert.ok(withOutline.length, '广播快照里没有大纲，面板会显示"已生成画像"配一棵空树');
  assert.ok(withOutline.every((c) => c.payload.hasProfile), 'hasProfile 与 profileYaml 不一致');
});

test('同页预检被后来请求替代时，丢弃旧画像但仍计入实际用量', async () => {
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).done === 1);
  const gate = deferred();
  preflightProfile = { domain: ['superseded profile'] };
  nextPreflightGate = gate;
  const old = send('run-preflight');
  await waitUntil(() => preflightCalls().length === 1);
  preflightProfile = { domain: ['current profile'] };
  const current = await send('run-preflight');
  assert.equal(current.ok, true);
  gate.resolve();
  assert.equal((await old).code, 'stale');
  const state = await send('get-state');
  assert.match(state.profileYaml, /current profile/);
  assert.doesNotMatch(state.profileYaml, /superseded profile/);
  const diagnostic = (await send('get-diagnostics')).diagnostic;
  assert.deepEqual(diagnostic.usageByPhase.preflight, { input: 200, output: 40, incomplete: false });
  assert.ok(diagnostic.events.some(row => row.event === 'preflight-discarded' && row.details.reason === 'superseded-or-stopped'));
});

test('SPA 换页：预检摘要必须来自新页面的正文', async () => {
  await send('clear-page');
  calls.length = 0;
  document.querySelector('article').innerHTML =
    '<h1>Wayland compositors</h1><p>Compositors implement the Wayland protocol for clients.</p>';
  await send('start', { config: CONFIG });
  await tick(300);

  // 换到完全不同主题的一页。URL 必须和前面用例用过的不同 ——
  // 换页检测靠 href/title 变化，撞了地址就不算换页
  dom.reconfigure({ url: 'https://wiki.example.org/digest-check' });
  document.querySelector('article').innerHTML =
    '<h1>Perfection of security interests</h1>' +
    '<p>A security interest in chattel paper may be perfected by filing.</p>';
  calls.length = 0;
  await tick(700);

  const pf = calls.filter((c) => c.type === 'preflight');
  assert.ok(pf.length, '换页后没有重新预检');
  // 旧 units 没清干净时，摘要里会带着上一页的正文 —— 这正是之前漏掉的那条
  const digest = pf[pf.length - 1].payload.digest;
  assert.ok(digest.includes('security interest'), '预检摘要里没有新页面的正文');
  assert.ok(!digest.includes('Compositors implement'), '预检摘要里混进了上一页的正文');
});

test('SPA 换页：真正迟到的旧 chunk 不得写进新页，也不得继续发送旧 chunks', async () => {
  await send('clear-page');
  document.querySelector('article').innerHTML =
    '<p>The compositor manages surfaces for clients.</p>' +
    '<p>The compositor schedules frames for every output.</p>';
  chunkPrefix = '【旧页】';
  const oldChunk = deferred();
  nextChunkGate = oldChunk;
  await send('start', { config: { ...CONFIG, autoPreflight: false } });
  await tick(220); // 150ms flush 后，旧页第一批已经真正进入 sendMessage 并被 gate 卡住
  assert.ok(chunkCalls().length >= 1, '没有制造出在飞的旧 chunk');

  dom.reconfigure({ url: 'https://wiki.example.org/glossary-check' });
  document.querySelector('article').innerHTML = '<p>A bailee holds the goods under a document.</p>';
  chunkPrefix = '【新页】';
  calls.length = 0;

  // MutationObserver 400ms + 新 scheduler 150ms。旧 chunk 仍被我们手动卡住。
  await tick(700);
  const beforeOldReturns = chunkCalls();
  assert.ok(beforeOldReturns.length, '新页面没有在旧请求仍阻塞时建立自己的调度');
  for (const c of beforeOldReturns) {
    assert.ok(
      (c.payload.items || []).every((it) => !String(it.text).includes('compositor')),
      '旧页剩余 chunks 被包装成新 session 继续发送了'
    );
  }

  oldChunk.resolve();
  await tick(100);
  const rendered = [...document.querySelectorAll('.byom-t')].map((n) => n.textContent).join('\n');
  assert.ok(rendered.includes('【新页】'), '新页面合法响应没有写入');
  assert.ok(!rendered.includes('【旧页】'), '迟到的旧页面响应写进了新页面 DOM');
  chunkPrefix = '【译】';
});

test('SPA 换页：旧 preflight 晚到不能清新 gate，也不能覆盖新画像', async () => {
  await send('clear-page');
  calls.length = 0;
  document.querySelector('article').innerHTML = '<p>The compositor manages surfaces for clients.</p>';
  preflightProfile = { domain: ['Linux'], hard: { compositor: '合成器' }, risky: {} };
  const oldPreflight = deferred();
  nextPreflightGate = oldPreflight;
  await send('start', { config: { ...CONFIG, autoPreflight: true } });
  await tick(40);
  assert.equal(preflightCalls().length, 1, '没有制造出在飞的旧 preflight');
  assert.equal(chunkCalls().length, 0, '旧 preflight 未完成时已经翻译');

  preflightProfile = { domain: ['法律'], hard: { bailee: '受托保管人' }, risky: {} };
  dom.reconfigure({ url: 'https://wiki.example.org/preflight-race' });
  document.querySelector('article').innerHTML = '<p>A bailee holds the goods under a document.</p>';
  await tick(700);

  // 新页自己的 preflight 应该已经结束并放行；旧页 preflight 仍然卡着。
  const freshChunks = chunkCalls().filter((c) =>
    (c.payload.items || []).some((it) => String(it.text).includes('bailee'))
  );
  assert.ok(freshChunks.length, '旧 gate 把新页面也卡死了，或新 gate 被旧 gate 清掉');
  for (const c of freshChunks) {
    assert.equal(c.payload.context.preflightSuggestions?.bailee, '受托保管人', '新画像没有进入翻译请求');
    assert.ok(!c.payload.context.preflightSuggestions?.compositor, '旧画像混进了新页面');
  }

  oldPreflight.resolve();
  await tick(100);
  const state = await send('get-state');
  assert.ok((state.profileYaml || '').includes('bailee'), '旧 preflight 晚到覆盖了新画像');
  assert.ok(!(state.profileYaml || '').includes('compositor'), '旧画像在晚到后重新出现');
});

test('opaque semanticRevision 变化会建立新 session，旧模型请求不能写回', async () => {
  await send('clear-page');
  calls.length = 0;
  document.querySelector('article').innerHTML = '<p>The fabric carries traffic between nodes.</p>';
  chunkPrefix = '【旧模型】';
  const oldChunk = deferred();
  nextChunkGate = oldChunk;
  await send('start', { config: { ...CONFIG, autoPreflight: false, semanticRevision: 'model-a' } });
  await tick(220);
  assert.ok(chunkCalls().length, '没有制造出旧模型的在飞请求');

  chunkPrefix = '【新模型】';
  await send('config-changed', {
    config: { ...CONFIG, autoPreflight: false, semanticRevision: 'model-b' }
  });
  await tick(250);
  oldChunk.resolve();
  await tick(100);

  const rendered = [...document.querySelectorAll('.byom-t')].map((n) => n.textContent).join('\n');
  assert.ok(rendered.includes('【新模型】'), '新 semanticRevision 没有产生新页面结果');
  assert.ok(!rendered.includes('【旧模型】'), '旧 semanticRevision 的响应写进了新 session');
  const aborts = calls.filter((c) => c.type === 'abort-session');
  assert.ok(aborts.length, '语义版本变化没有中止旧后台 session');
  chunkPrefix = '【译】';
});

test('重翻一次之后，下次翻译不该继续绕过缓存', async () => {
  await send('clear-page');
  calls.length = 0;
  await send('restart-page', { bypass: true });
  await tick(300);
  assert.ok(
    calls.filter((c) => c.type === 'translate-chunk').some((c) => c.payload.bypassCache),
    '「重翻⟳」没有绕过缓存'
  );

  // 再走一次普通翻译：bypassCache 必须已经复位
  await send('clear-page');
  calls.length = 0;
  await send('start', { config: CONFIG });
  await tick(300);
  const chunks = calls.filter((c) => c.type === 'translate-chunk');
  assert.ok(chunks.length, '没有发出翻译请求');
  assert.ok(
    chunks.every((c) => !c.payload.bypassCache),
    'bypassCache 没复位，此后整个会话都在静默绕过缓存烧钱'
  );
});

test('显示方式是设置：页面上切换会写回，不只是改当前页 DOM', async () => {
  calls.length = 0;
  const before = document.documentElement.dataset.byomDisplay;
  await send('toggle-visibility');
  assert.notEqual(document.documentElement.dataset.byomDisplay, before, '模式没有切换');
  const saved = calls.find((c) => c.type === 'save-display-mode');
  assert.ok(saved, '切换后没有写回设置——下一页打开就会退回默认');
  assert.ok(['bilingual', 'translation', 'original'].includes(saved.payload.mode));
});

test('启动时按配置里的显示方式渲染，不用等翻完再调', async () => {
  await send('clear-page');
  await send('start', { config: { ...CONFIG, displayMode: 'translation' } });
  await tick(50);
  assert.equal(
    document.documentElement.dataset.byomDisplay,
    'translation',
    '配置里选好的显示方式没有在翻译前生效'
  );
  await send('clear-page');
});

test('行内碎片合并后，送进 translate-chunk 的是完整句子', async () => {
  await send('clear-page');
  document.querySelector('article').innerHTML =
    '<p>Deployed <relative-time>2 days ago</relative-time> by <a href="#">alice</a> to <strong>production</strong>.</p>' +
    '<p>First line stays here.<br>Second line stays here.</p>';
  calls.length = 0;
  await send('start', { config: { ...CONFIG, autoPreflight: false } });
  await tick(300);

  const items = chunkCalls().flatMap((c) => c.payload.items.map((it) => it.text));
  assert.ok(
    items.includes('Deployed 2 days ago by alice to production.'),
    `句子被行内标签切碎了：${JSON.stringify(items)}`
  );
  assert.ok(
    items.includes('First line stays here. Second line stays here.'),
    `<br> 两侧被拆散或粘连：${JSON.stringify(items)}`
  );
  assert.equal(items.length, 2, `应当恰好两个完整单元：${JSON.stringify(items)}`);
});

test('整页优先：在 token 安全预算内仍只发一个完整请求', async () => {
  await send('clear-page');
  const source = Array.from(
    { length: 24 },
    (_, i) => `Paragraph ${i + 1} carries context needed by the rest of this document.`
  );
  document.querySelector('article').innerHTML = source.map((text) => `<p>${text}</p>`).join('');
  calls.length = 0;

  await send('start', {
    config: {
      ...CONFIG,
      autoPreflight: false,
      maxCharsPerChunk: 30,
      wholePageTranslation: true,
      semanticRevision: 'whole-page-auto'
    }
  });
  await tick(300);

  const chunks = chunkCalls();
  assert.equal(chunks.length, 1, `整页优先实际发了 ${chunks.length} 个 translate-chunk`);
  assert.equal(chunks[0].payload.items.length, 24, '完整正文没有进入同一次请求');
  assert.deepEqual(chunks[0].payload.items.map((it) => it.text), source, '正文顺序或边界被改写');
  assert.equal(chunks[0].payload.context.wholePage, true, '后台没有收到整页模式标记');
  const state = await send('get-state');
  assert.equal(state.translationRuntime.translationMode, 'whole-page');
  assert.equal(state.translationRuntime.modeReason, 'within-safe-range');
  assert.equal(state.translationRuntime.budgetMode, 'estimated-tokens');
  assert.ok(state.translationRuntime.estimatedInputTokens > 0);
  assert.ok(state.translationRuntime.estimatedOutputTokens > 0);
  assert.equal(state.translationRuntime.unitCount, 24);
  assert.equal(state.translationRuntime.translateRequestCount, 1);
});

test('关掉自动预检时不发预检请求，也不该卡住翻译', async () => {
  await send('clear-page');
  calls.length = 0;
  await send('start', { config: { ...CONFIG, autoPreflight: false } });
  await tick(200);
  assert.equal(preflightCalls().length, 0, '已关闭自动预检却仍然发起了预检');
  assert.ok(chunkCalls().length > 0, '关掉预检后翻译被卡住了');
});

test('一次性诊断只含结构化运行信息，复制成功后可清空当前事件', async () => {
  const before = await send('get-diagnostics');
  assert.equal(before.ok, true);
  assert.equal(before.diagnostic.format, 'just-translate-diagnostic/v1');
  assert.ok(before.diagnostic.translationRuntime, '运行统计被脱敏器误当成译文正文删掉了');
  assert.equal(before.diagnostic.extraction.scope, 'top-document-open-shadow-dom');
  assert.equal(before.diagnostic.extraction.completed, true);
  assert.ok(before.diagnostic.extraction.candidateUnits > 0, '复制日志必须带实际提取快照');
  assert.equal(typeof before.diagnostic.extraction.skippedCandidates, 'object', '过滤原因不能被脱敏器删掉');
  assert.ok(before.diagnostic.events.some((row) => row.event === 'translate-request'));
  assert.ok(before.diagnostic.events.some((row) => row.event === 'translate-result'));
  const request = before.diagnostic.events.find((row) => row.event === 'translate-request');
  const result = before.diagnostic.events.find((row) => row.event === 'translate-result' && row.details.requestId === request.details.requestId);
  assert.ok(result, '并发请求与结果没有稳定 requestId，无法配对');
  const json = JSON.stringify(before.diagnostic);
  assert.ok(!json.includes('Wayland is a display server protocol'), '诊断包泄漏了页面正文');
  assert.ok(!json.includes('【译】'), '诊断包泄漏了译文');

  const cleared = await send('clear-diagnostics', {
    logId: before.diagnostic.logId, throughSequence: before.diagnostic.throughSequence
  });
  assert.equal(cleared.ok, true);
  const after = await send('get-diagnostics');
  assert.deepEqual(after.diagnostic.events.map((row) => row.event), ['log-cleared', 'log-exported']);
});

test('被动读取只取快照，反复复制不会把真事件挤出环形日志', async () => {
  const before = await send('get-diagnostics', { passive: true });
  const events = before.diagnostic.events.map((row) => row.event);
  const requestsBefore = calls.length;
  for (let i = 0; i < 5; i++) await send('get-diagnostics', { passive: true });
  const after = await send('get-diagnostics', { passive: true });
  assert.deepEqual(after.diagnostic.events.map((row) => row.event), events, '被动读取往日志里记了事件');
  assert.equal(calls.length, requestsBefore, '提取快照不应发起翻译或其他后台请求');
  assert.deepEqual(after.diagnostic.extraction, before.diagnostic.extraction, '稳定页面的提取快照应相同');
  assert.ok(after.diagnostic.translationRuntime, '被动读取拿到的仍应是完整快照');
  const active = await send('get-diagnostics');
  assert.equal(active.diagnostic.events.at(-1).event, 'log-exported', '一次性复制仍要留下交接水位');
});

test('缓存回填不进入 alignment 分母，并明确记录未观测单元数', async () => {
  await send('clear-page');
  document.querySelector('article').innerHTML =
    '<p>Battery power remains low.</p><p>Reserve power remains low.</p>';
  nextChunkResponse = (msg) => ({
    ok: true,
    items: msg.payload.items.map((item) => ({ i: item.i, t: '缓存译文', cached: true })),
    failed: [],
    runtime: { translateRequestCount: 0, splitRetryCount: 0, wholePageCacheHit: false }
  });
  await send('start', {
    config: { ...CONFIG, autoPreflight: false, semanticConsistency: true, useCache: true }
  });
  await tick(250);

  const state = await send('get-state');
  assert.equal(state.consistencyTelemetry.summary.expectedOccurrences, 0);
  assert.equal(state.consistencyTelemetry.summary.alignedOccurrences, 0);
  assert.equal(state.consistencyTelemetry.summary.cachedUnitsExcludedFromObservation, 2);
});

test('失败批次把请求次数与已消耗 token 计入诊断，并用 requestId 对上原请求', async () => {
  await send('clear-page');
  document.querySelector('article').innerHTML = '<p>The cylinder opens over the pit.</p>';
  nextChunkResponse = {
    ok: false,
    code: 'api-error',
    error: { message: '模型没有返回可解析的 JSON', status: 0 },
    usage: { input: 300, output: 120 },
    runtime: { translateRequestCount: 3, splitRetryCount: 0, wholePageCacheHit: false }
  };
  await send('start', {
    config: { ...CONFIG, autoPreflight: false, semanticConsistency: false, useCache: false }
  });
  await tick(250);

  const state = await send('get-state');
  assert.equal(state.failed, 1);
  assert.equal(state.tokens.input, 300);
  assert.equal(state.tokens.output, 120);
  assert.equal(state.translationRuntime.translateRequestCount, 3);

  const diagnostic = (await send('get-diagnostics')).diagnostic;
  const failure = diagnostic.events.find((row) => row.event === 'translate-error');
  const request = diagnostic.events.find((row) =>
    row.event === 'translate-request' && row.details.requestId === failure.details.requestId
  );
  assert.ok(request);
  assert.equal(failure.details.category, 'invalid-response');
  assert.equal(failure.details.runtime.translateRequestCount, 3);
  assert.equal(failure.details.usage.inputTokens, 300);
});

/* -------------------------------- 运行 -------------------------------- */

async function waitUntil(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await tick(10);
  }
  throw new Error('等待状态超时');
}

async function startAuditPage(extra = {}) {
  await send('stop');
  await send('clear-page');
  document.querySelector('article').innerHTML = '<p>Battery health and battery life matter for portable devices and their everyday use.</p>';
  calls.length = 0;
  await send('start', { config: { ...CONFIG, autoPreflight: false, skipSameScript: false, ...extra } });
}

test('英译英和中译中照常执行；不调用语言识别，也不出现源语言闸门', async () => {
  chrome.i18n = { detectLanguage: () => { throw Error('Page language detection must stay removed'); } };
  for (const [targetLang, text] of [['English', 'This page already uses English and must still enter translation.'],
    ['简体中文', '这段正文已经是中文，用户点击后仍然进入所选引擎。']]) {
    await send('stop');
    await send('clear-page');
    document.querySelector('article').innerHTML = `<p>${text}</p>`;
    calls.length = 0;
    await send('start', { config: { ...CONFIG, targetLang, autoPreflight: true } });
    await waitUntil(async () => (await send('get-state')).done === 1);
    assert.equal(preflightCalls().length, 1);
    assert.equal(chunkCalls().length, 1);
    assert.equal(chunkCalls()[0].payload.items[0].text, text);
    const state = await send('get-state');
    assert.ok(!Object.hasOwn(state, 'language'));
    const hud = document.getElementById('byom-hud').shadowRoot;
    assert.equal(hud.querySelector('[data-act="stop"]').textContent, targetLang === 'English' ? 'Retry' : '重翻');
    const diagnostics = (await send('get-diagnostics')).diagnostic;
    assert.equal(diagnostics.config.targetLang, targetLang);
    assert.ok(!diagnostics.events.some(e => e.event === 'language-decision'));
  }
  delete chrome.i18n;
});

test('切目标语言重新预检，同语言同正文重翻才复用', async () => {
  preflightProfile = { domain: ['battery'], preferred: { 'Battery health': '电池健康' } };
  await startAuditPage({ autoPreflight: true });
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(preflightCalls().length, 1);
  preflightProfile = { domain: ['battery'], preferred: { 'Battery health': 'Battery Health' } };
  await send('config-changed', { config: { ...CONFIG, autoPreflight: true, skipSameScript: false, targetLang: 'English', semanticRevision: 'english-audit' } });
  await waitUntil(() => preflightCalls().length === 2 && chunkCalls().length === 2);
  assert.equal(chunkCalls().at(-1).payload.context.preflightSuggestions['Battery health'], 'Battery Health');
  await send('restart-page');
  await waitUntil(() => chunkCalls().length === 3);
  assert.equal(preflightCalls().length, 2);
});

test('重复双击同一在途单元不重复发请求或计数', async () => {
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).done === 1);
  const node = document.querySelector('.byom-t');
  const gate = deferred();
  nextChunkGate = gate;
  node.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await waitUntil(() => chunkCalls().length === 2);
  node.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await tick(20);
  assert.equal(chunkCalls().length, 2);
  gate.resolve();
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal((await send('get-state')).total, 1);
});

test('停止再开始重新登记已有译文，不留下孤立单元', async () => {
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).done === 1);
  await send('stop');
  await send('start', { config: { ...CONFIG, autoPreflight: false } });
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal((await send('get-state')).total, 1);
  assert.equal(document.querySelectorAll('.byom-t').length, 1);
});

test('仅译文模式在等待响应时停止会恢复原文', async () => {
  const gate = deferred();
  nextChunkGate = gate;
  await startAuditPage({ displayMode: 'translation' });
  await waitUntil(() => chunkCalls().length === 1);
  await send('stop');
  assert.equal(document.querySelectorAll('.byom-t').length, 0);
  assert.equal(document.querySelectorAll('[data-byom-src], [data-byom-src-in]').length, 0);
  gate.resolve();
  await tick(20);
  assert.equal(document.querySelectorAll('.byom-t').length, 0);
});

test('旧配置广播不能回滚新版本', async () => {
  await startAuditPage({ configVersion: 20 });
  await waitUntil(async () => (await send('get-state')).done === 1);
  const before = chunkCalls().length;
  await send('config-changed', { config: { ...CONFIG, configVersion: 19, semanticRevision: 'obsolete' } });
  await tick(30);
  assert.equal(chunkCalls().length, before);
});

test('写入译文不触发正文重扫，正文变化仍触发', async () => {
  await send('stop');
  const { createMutationWatcher } = await import('../src/content/observer.js');
  let dirty = 0;
  const watcher = createMutationWatcher(() => dirty++, { debounceMs: 1 });
  const node = document.querySelector('.byom-t');
  watcher.start();
  node.textContent = 'Updated translation.';
  await tick(20);
  assert.equal(dirty, 0);
  document.querySelector('article p').firstChild.textContent = 'Updated original text.';
  await waitUntil(() => dirty === 1);
  watcher.stop();
});

test('纯删除退役原单元和孤立译文，计数随当前页面变化', async () => {
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).done === 1);
  document.querySelector('article p').remove();
  await waitUntil(async () => (await send('get-state')).total === 0);
  assert.equal(document.querySelectorAll('.byom-t').length, 0);
});

test('属性隐藏与恢复重新核对提取范围', async () => {
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).done === 1);
  const original = document.querySelector('article p');
  original.hidden = true;
  await waitUntil(async () => (await send('get-state')).total === 0);
  original.hidden = false;
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(chunkCalls().length, 2);
});

test('响应快于 DOM 防抖时也不能提交过期原文译文', async () => {
  const gate = deferred();
  nextChunkGate = gate;
  await startAuditPage();
  await waitUntil(() => chunkCalls().length === 1);
  document.querySelector('article p').firstChild.textContent = 'A changed source sentence needs a new translation.';
  gate.resolve();
  await tick(20);
  assert.equal(document.querySelector('.byom-t')?.dataset.byomState, undefined);
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(chunkCalls().length, 2);
});

test('预检途中正文变化丢弃旧画像，只补一次新正文预检', async () => {
  const gate = deferred();
  nextPreflightGate = gate;
  preflightProfile = { domain: ['old battery context'] };
  await startAuditPage({ autoPreflight: true });
  await waitUntil(() => preflightCalls().length === 1);
  document.querySelector('article p').firstChild.textContent = 'A replacement article about display settings and desktop monitors.';
  preflightProfile = { domain: ['new display context'] };
  gate.resolve();
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(preflightCalls().length, 2);
  assert.match(preflightCalls()[1].payload.digest, /replacement article/);
  assert.equal(chunkCalls().length, 1);
  assert.match(chunkCalls()[0].payload.items[0].text, /replacement article/);
  assert.deepEqual(chunkCalls()[0].payload.context.profile.domain, ['new display context']);
});

test('后台失去会话时停止剩余队列并提示重新开始', async () => {
  nextChunkResponse = { ok: false, code: 'session-expired', error: { message: '后台会话已失效，请重新开始翻译' } };
  await startAuditPage();
  await waitUntil(async () => (await send('get-state')).running === false);
  const state = await send('get-state');
  assert.equal(state.phase, 'error');
  assert.match(state.message, /重新开始翻译/);
  assert.equal(chunkCalls().length, 1);
});

test('仅译文模式的布局核对不会把自己隐藏的原文退役', async () => {
  const style = document.createElement('style');
  style.textContent = 'html[data-byom-display="translation"] [data-byom-src] { display:none !important; }';
  document.head.append(style);
  const prototype = dom.window.Element.prototype;
  const previous = prototype.checkVisibility;
  prototype.checkVisibility = function () { return getComputedStyle(this).display !== 'none'; };
  try {
    await startAuditPage({ displayMode: 'translation' });
    await waitUntil(async () => (await send('get-state')).done === 1);
    document.querySelector('article p').classList.add('ordinary-class');
    await tick(500);
    assert.equal((await send('get-state')).done, 1);
    assert.equal(chunkCalls().length, 1);
    assert.equal(document.documentElement.dataset.byomDisplay, 'translation');
  } finally {
    if (previous) prototype.checkVisibility = previous;
    else delete prototype.checkVisibility;
    style.remove();
  }
});

test('正文连续变化最多补一次预检，之后用当前正文继续', async () => {
  const first = deferred();
  const second = deferred();
  nextPreflightGate = first;
  await startAuditPage({ autoPreflight: true });
  await waitUntil(() => preflightCalls().length === 1);
  nextPreflightGate = second;
  document.querySelector('article p').firstChild.textContent = 'First replacement about a new topic and its details.';
  first.resolve();
  await waitUntil(() => preflightCalls().length === 2);
  document.querySelector('article p').firstChild.textContent = 'Second replacement with the current content that should be translated.';
  second.resolve();
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(preflightCalls().length, 2);
  assert.equal(chunkCalls().length, 1);
  assert.match(chunkCalls()[0].payload.items[0].text, /Second replacement/);
  assert.equal((await send('get-state')).hasProfile, false);
});

test('开放组件正文参与整页请求、预检与诊断，内部双击只重翻该段', async () => {
  await send('stop');
  await send('clear-page');
  document.querySelector('article').innerHTML = '<h1>Discussion Forum</h1><course-content></course-content>';
  const shadow = document.querySelector('course-content').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="d2l-html-block-rendered"><p>Please take notes during class.</p><p>Ask your peers for help.</p></div>';
  calls.length = 0;
  await send('start', { config: { ...CONFIG, wholePageTranslation: true } });
  await waitUntil(async () => (await send('get-state')).done === 3);
  assert.equal(preflightCalls().length, 1);
  assert.match(preflightCalls()[0].payload.digest, /Please take notes during class/);
  assert.equal(chunkCalls().length, 1);
  assert.deepEqual(chunkCalls()[0].payload.items.map(item => item.text), [
    'Discussion Forum', 'Please take notes during class.', 'Ask your peers for help.'
  ]);
  assert.equal(shadow.querySelectorAll('.byom-t[data-byom-state="done"]').length, 2);
  const { diagnostic } = await send('get-diagnostics', { passive: true });
  assert.equal(diagnostic.extraction.candidateUnits, 3);
  assert.equal(diagnostic.extraction.existingTranslationUnits, 3);
  const node = shadow.querySelector('.byom-t');
  node.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, composed: true }));
  await waitUntil(() => chunkCalls().length === 2);
  assert.equal(chunkCalls()[1].payload.bypassCache, true);
  assert.deepEqual(chunkCalls()[1].payload.items.map(item => item.text), ['Please take notes during class.']);
  await waitUntil(async () => (await send('get-state')).done === 3);
  await send('clear-page');
  assert.equal(shadow.querySelectorAll('.byom-t,[data-byom-src]').length, 0);
});

test('组件重绘期间旧响应不能写回，移除宿主后会话释放内部单元', async () => {
  await send('stop');
  await send('clear-page');
  document.querySelector('article').innerHTML = '<course-content></course-content>';
  const host = document.querySelector('course-content');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<p>Original course instructions.</p>';
  const gate = deferred();
  nextChunkGate = gate;
  calls.length = 0;
  await send('start', { config: { ...CONFIG, autoPreflight: false } });
  await waitUntil(() => chunkCalls().length === 1);
  const oldNode = shadow.querySelector('.byom-t');
  shadow.innerHTML = '<p>Replaced course instructions.</p>';
  gate.resolve();
  await waitUntil(async () => (await send('get-state')).done === 1);
  assert.equal(oldNode.dataset.byomState, 'loading', '迟到结果不应写入旧节点');
  assert.equal(chunkCalls().length, 2);
  assert.equal(chunkCalls()[1].payload.items[0].text, 'Replaced course instructions.');
  host.remove();
  await waitUntil(async () => (await send('get-state')).total === 0);
  await send('stop');
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
