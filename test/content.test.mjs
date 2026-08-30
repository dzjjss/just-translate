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
let nextChunkGate = null;
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
        return { ok: true, profile, usage: { input: 100, output: 20 } };
      }
      if (msg.type === 'abort-session') return { ok: true };
      if (msg.type === 'translate-chunk') {
        const prefix = chunkPrefix;
        const gate = nextChunkGate;
        nextChunkGate = null;
        if (gate) await gate.promise;
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

test('整页优先：在 12k / 80 段安全范围内仍只发一个完整请求', async () => {
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

/* -------------------------------- 运行 -------------------------------- */

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
