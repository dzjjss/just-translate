/**
 * 提取器回归测试。DOM 提取是这个项目唯一的护城河，也是最容易在改动中悄悄退化的部分，
 * 所以每个已经踩过的坑都在这里留一个用例。
 *
 *   npm i -D jsdom && node test/extractor.test.mjs
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert';

const CONFIG = {
  minTextLength: 2,
  smartFilter: true,
  skipSelectors: '',
  targetLang: '简体中文'
};
// 排版检测在 jsdom 里拿不到真实布局，单独开关掉以免干扰其它用例
const LOOSE = { ...CONFIG, skipTightLayout: false };

let scan, resetIds, collectPageContext, attach, fill, buildChunks;
let applyPresentation, removeAll, listProviders;
let parseTranslationResponse, extractJsonObject, classifyPage, promptFingerprint, buildMessages;
let buildPreflightMessages;
let parsePreflightProfile, buildPlainDigest, detectGlossaryDrift;
let cacheKey, Queue, fab;
let normalizeBase, checkKey, parseModelList, filterChatModels;
let toYaml, fromYaml, mergeRules, isEmptyRules;
let renderRulesTree, buildSources;
let isLinkList;

function mount(html, url = 'https://docs.example.com/page') {
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.location = dom.window.location;
  global.MutationObserver = dom.window.MutationObserver;
  resetIds?.();
  return dom.window.document;
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const texts = (units) => units.map((u) => u.text);

/* ------------------------------------------------------------------ */

test('行内元素不拆句子，块级跳过标签才打断', () => {
  const doc = mount(`<body><article>
    <p>The <a href="/x">fabric</a> provides <code>high-bandwidth</code> links<sup>[1]</sup>.</p>
    <div>Before the block.<pre><code>ip route add default</code></pre>After the block.</div>
  </article></body>`);
  const t = texts(scan(doc.body, CONFIG));
  assert.deepEqual(t, [
    'The fabric provides high-bandwidth links[1].',
    'Before the block.',
    'After the block.'
  ]);
});

test('自定义元素默认按行内处理：句子不拆、碎片不被单 token 过滤器丢掉', () => {
  const doc = mount(`<body><article>
    <p>Deployed <relative-time>2 days ago</relative-time> by <a href="#">alice</a> to production.</p>
  </article></body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Deployed 2 days ago by alice to production.']);
});

test('自定义元素显式声明成块级时仍按块处理', () => {
  const doc = mount(`<body><article>
    <p>Before paragraph text.</p>
    <status-badge style="display:block">Standalone badge text</status-badge>
    <p>After paragraph text.</p>
  </article></body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), [
    'Before paragraph text.',
    'Standalone badge text',
    'After paragraph text.'
  ]);
});

test('自定义元素裹着块级内容时不做行内合并（Google 卡片同款守卫）', () => {
  const doc = mount(
    `<body><article><my-card><h3>Card title here</h3><p>Card body paragraph.</p></my-card></article></body>`
  );
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Card title here', 'Card body paragraph.']);
});

test('<br> 两侧句子合成一个单元，且中间不粘连', () => {
  const doc = mount(`<body><article><p>First line of text.<br>Second line of text.</p></article></body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['First line of text. Second line of text.']);
});

test('script / svg / 表单控件不进正文，也不打断句子', () => {
  const doc = mount(`<body><p>Latency <script>var a=1</script>matters <svg><title>icon</title></svg>here.</p>
    <p>Pick <select><option>one</option></select> a value.</p></body>`);
  const t = texts(scan(doc.body, CONFIG));
  assert.deepEqual(t, ['Latency matters here.', 'Pick a value.']);
});

test('notranslate / translate=no / aria-hidden / contenteditable 全部跳过', () => {
  const doc = mount(`<body><div>
    <span class="notranslate">Keep this string.</span>
    <span translate="no">And this one.</span>
    <p aria-hidden="true">Hidden from a11y tree.</p>
    <div contenteditable="true">User is typing here.</div>
    <p>Only this line should be translated.</p>
  </div></body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Only this line should be translated.']);
});

test('脚本不等于语言：日中互译不能因为都含汉字就整页跳过', () => {
  const html = `<body><main>
    <p>これは日本語の文章です。翻訳されるべきです。</p>
    <p>Hello world, this is an English sentence.</p>
    <p>这是中文段落，不应该被翻译。</p>
  </main></body>`;

  // 目标中文：日文段落必须翻（它含大量假名，不是中文），中文段落跳过
  const zh = texts(scan(mount(html), { ...LOOSE, targetLang: '简体中文' }));
  assert.ok(zh.some((t) => t.includes('日本語')), '日文正文被当成"已经是中文"整段跳过了');
  assert.ok(!zh.some((t) => t.includes('不应该被翻译')), '中文段落不该再翻一遍');

  // 反向：目标日文时，中文段落要翻，日文跳过
  const ja = texts(scan(mount(html), { ...LOOSE, targetLang: '日本語' }));
  assert.ok(ja.some((t) => t.includes('这是中文段落')), '中文正文被当成"已经是日文"跳过了');
  assert.ok(!ja.some((t) => t.includes('これは日本語')), '日文段落不该再翻一遍');
});

test('无空格语言不是“单 token”：中文/泰文短段落翻成英语不能被 smartFilter 吞掉', () => {
  const doc = mount(`<body><main>
    <p>网络配置说明</p>
    <p>การตั้งค่าเครือข่าย</p>
    <p>Username</p>
  </main></body>`);
  const out = texts(scan(doc.body, { ...LOOSE, targetLang: 'English' }));
  assert.ok(out.includes('网络配置说明'), '中文无标点短段落被当成单 token 跳过');
  assert.ok(out.includes('การตั้งค่าเครือข่าย'), '泰文无空格短段落被当成单 token 跳过');
  assert.ok(!out.includes('Username'), '真正的单个拉丁 UI token 仍应被 smartFilter 跳过');
});

test('跳过选择器写错一个字符，不能把整页扫描一起带走', () => {
  const doc = mount('<body><main><p>First paragraph here.</p><p>Second paragraph here.</p></main></body>');
  // 逃生口本身炸掉是最糟的组合：用户只会看到"没有找到可翻译的内容"
  const t = texts(scan(doc, { ...LOOSE, skipSelectors: '.foo:::bar' }));
  assert.equal(t.length, 2, `坏选择器吞掉了整页，只提取到 ${t.length} 段`);

  // 正常选择器仍然生效
  const doc2 = mount('<body><main><p class="ad">Sponsored.</p><p>Real content here.</p></main></body>');
  assert.deepEqual(texts(scan(doc2, { ...LOOSE, skipSelectors: '.ad' })), ['Real content here.']);
});

test('纯数字 / 纯 URL / 已是目标语言的段落不消耗 token', () => {
  const doc = mount(`<body>
    <p>42 / 3.14 — 2024</p>
    <p>https://example.com/a/b?c=d</p>
    <p>这一段已经是中文了。</p>
    <p>This one is not.</p>
  </body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['This one is not.']);
});

test('列表 / 单元格 / 图注的译文追加到内部而不是插兄弟节点', () => {
  const doc = mount(`<body>
    <ul><li>First item here</li></ul>
    <table><tr><td>Latency budget</td></tr></table>
    <figure><figcaption>Figure 1. Topology</figcaption></figure>
    <p>A normal paragraph</p>
  </body>`);
  const modes = Object.fromEntries(scan(doc.body, CONFIG).map((u) => [u.el.tagName, u.mode]));
  assert.deepEqual(modes, { LI: 'append', TD: 'append', FIGCAPTION: 'append', P: 'after' });
});

test('嵌套容器只在叶子块产出，父容器不会重复整段文字', () => {
  const doc = mount(`<body><div class="thread">
    <div class="comment"><div class="body"><p>Top level opinion.</p></div>
      <div class="comment"><div class="body"><p>Nested reply.</p></div></div>
    </div>
  </div></body>`);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Top level opinion.', 'Nested reply.']);
});

test('skipSelectors 生效', () => {
  const doc = mount(`<body><aside class="sidebar"><p>Sidebar noise here.</p></aside>
    <main><p>Main content here.</p></main></body>`);
  const units = scan(doc.body, { ...CONFIG, skipSelectors: '.sidebar' });
  assert.deepEqual(texts(units), ['Main content here.']);
});

test('重复扫描收敛为零', () => {
  const doc = mount(`<body><article>
    <h1>Heading</h1><p>Body text with <em>emphasis</em>.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
  </article></body>`);
  const first = scan(doc.body, CONFIG);
  assert.equal(first.length, 4);
  first.forEach((u) => (attach(u), fill(u, '【译】' + u.text)));
  assert.equal(scan(doc.body, CONFIG).length, 0, '重复扫描产生了重复单元');
  assert.equal(doc.querySelector('li').lastElementChild.className, 'byom-t');
});

test('原文被改写时复用旧节点，不留孤儿', () => {
  const doc = mount(`<body><p>Original sentence.</p></body>`);
  const [u] = scan(doc.body, CONFIG);
  attach(u), fill(u, '【译】原句');
  doc.querySelector('p').textContent = 'Rewritten sentence.';
  const again = scan(doc.body, CONFIG);
  assert.equal(again.length, 1);
  assert.ok(again[0].node, '应复用已有译文节点');
  attach(again[0]), fill(again[0], '【译】改写后');
  assert.equal(doc.querySelectorAll('.byom-t').length, 1, '出现了孤儿译文节点');
  assert.equal(scan(doc.body, CONFIG).length, 0);
});

test('run 中间夹着旧译文时不会无限重译', () => {
  const doc = mount(`<body><div>Lead text.<pre>code</pre>Tail text.</div></body>`);
  scan(doc.body, CONFIG).forEach((u) => (attach(u), fill(u, '【译】' + u.text)));
  const div = doc.querySelector('div');
  div.insertBefore(doc.createTextNode(' More context.'), div.querySelector('pre'));
  const changed = scan(doc.body, CONFIG);
  assert.equal(changed.length, 1);
  changed.forEach((u) => (attach(u), fill(u, '【译】更新')));
  assert.equal(div.querySelectorAll('.byom-t').length, 2, '孤儿节点或位置错误');
  assert.equal(scan(doc.body, CONFIG).length, 0, '未收敛：会无限重译');
});

test('无限滚动：只产出新增内容', () => {
  const doc = mount(`<body><main><p>Existing paragraph.</p></main></body>`);
  scan(doc.body, CONFIG).forEach((u) => (attach(u), fill(u, '【译】已有')));
  const p = doc.createElement('p');
  p.textContent = 'Streamed in later.';
  doc.querySelector('main').appendChild(p);
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Streamed in later.']);
});

test('SPA 整段重绘：译文被清掉后重新产出（由缓存兜住成本）', () => {
  const doc = mount(`<body><div id="root"><p>Route A content.</p></div></body>`);
  scan(doc.body, CONFIG).forEach((u) => (attach(u), fill(u, '【译】A')));
  doc.getElementById('root').innerHTML = '<p>Route A content.</p>'; // 框架重建了子树
  assert.deepEqual(texts(scan(doc.body, CONFIG)), ['Route A content.']);
});

test('入队即占位，请求未返回时重复扫描不会堆出重复请求', () => {
  const doc = mount(`<body><main><p>Far below the fold.</p><p>Also far below.</p></main></body>`);
  const first = scan(doc.body, CONFIG);
  assert.equal(first.length, 2);
  // 占位抢在网络请求之前插好
  first.forEach((u) => attach(u));
  assert.equal(doc.querySelector('.byom-t').dataset.byomState, 'loading');

  // 页面别处发生变化触发重新扫描
  doc.querySelector('main').appendChild(doc.createElement('div'));
  assert.equal(scan(doc.body, CONFIG).length, 0, '在途段落被重复入队了');
});

test('原文在请求途中被改写时，旧响应会被拒绝写入', () => {
  const doc = mount(`<body><p>Original sentence here.</p></body>`);
  const [inflight] = scan(doc.body, CONFIG); // 请求 A 已发出
  attach(inflight);

  doc.querySelector('p').textContent = 'Rewritten sentence here.';
  const [fresh] = scan(doc.body, CONFIG); // 请求 B
  attach(fresh);
  assert.equal(fill(fresh, '【译】改写后'), true);

  // A 迟到返回，必须被丢掉而不是覆盖 B
  assert.equal(fill(inflight, '【译】原句'), false, '过期响应覆盖了新译文');
  assert.equal(doc.querySelector('.byom-t').textContent, '【译】改写后');
});

test('缓存 key 随指令变化，改了 prompt 不会吃旧译文', () => {
  const base = { presetId: 'general', customPrompt: '尽量直译', targetLang: '简体中文' };
  const k = (o) =>
    cacheKey({ providerId: 'openai', model: 'm', fingerprint: promptFingerprint({ ...base, ...o }), text: 'bank' });
  assert.notEqual(k({}), k({ customPrompt: '尽量自然' }), '改自定义指令后仍命中旧缓存');
  assert.notEqual(k({}), k({ presetId: 'academic' }), '换页面语境后仍命中旧缓存');
  assert.notEqual(k({}), k({ targetLang: 'English' }), '换目标语言后仍命中旧缓存');
  assert.equal(k({}), k({}), '同样配置应当稳定命中');
});

test('停止翻译后，排队中的批次不会再发出去', async () => {
  const q = new Queue(1);
  const ctrl = new AbortController();
  const started = [];
  const block = q.add(async () => {
    started.push('A');
    await new Promise((r) => setTimeout(r, 30));
  }, ctrl.signal);
  const queued = q.add(async () => started.push('B'), ctrl.signal).catch((e) => e.name);

  ctrl.abort(); // A 在飞，B 还在排队
  await block;
  assert.equal(await queued, 'AbortError', '排队中的批次仍然被执行了');
  assert.deepEqual(started, ['A'], `不该启动的任务被启动了：${started}`);
});

test('行内元素裹着块级内容时按块级递归，标题与站点信息不再揉成一段', () => {
  // Google 搜索结果的真实结构：<a> 里裹整块卡片
  const doc = mount(`<body><div class="g">
    <a href="https://chexy.co">
      <div class="title">Chexy — Every bill on the card you already carry</div>
      <div class="site"><span>Chexy</span><cite>https://chexy.co</cite></div>
    </a>
    <div class="snippet">Pay rent and every major bill with your credit card.</div>
  </div></body>`);
  const t = texts(scan(doc.body, LOOSE));
  assert.ok(
    t.includes('Chexy — Every bill on the card you already carry'),
    `标题应当独立成段，实际得到：${JSON.stringify(t)}`
  );
  assert.ok(
    !t.some((x) => x.includes('carry') && x.includes('chexy.co')),
    '标题、站点名和网址又被揉进同一段了'
  );
});

test('单词条目默认不翻，但标题和成句短文本要翻', () => {
  const doc = mount(`<body><div class="card">
    <div class="author">Blueforcer</div>
    <span class="tag">· NG</span>
    <h2>Introduction</h2>
    <p>Yes.</p>
    <p>Total Yield Day Power</p>
  </div></body>`);
  const t = texts(scan(doc.body, LOOSE));
  assert.ok(!t.includes('Blueforcer'), '用户名不该送去翻译');
  assert.ok(!t.some((x) => x.includes('NG')), '标签碎片不该送去翻译');
  assert.ok(t.includes('Introduction'), '标题里的单词仍然要翻');
  assert.ok(t.includes('Yes.'), '带句末标点的短句仍然要翻');
  assert.ok(t.includes('Total Yield Day Power'), '多词短语不受影响');

  // 关掉开关时应当恢复原样
  assert.ok(texts(scan(mount(`<body><div class="author">Blueforcer</div></body>`),
    { ...LOOSE, skipSingleToken: false })).includes('Blueforcer'));
});

test('导航与页眉里的短文本不翻，正文不受影响', () => {
  const doc = mount(`<body>
    <nav><a href="/a">About LII</a><a href="/b">Get the law</a></nav>
    <header><span>Search Cornell</span></header>
    <main><p>A security interest in chattel paper may be perfected by filing.</p></main>
  </body>`);
  const t = texts(scan(doc.body, CONFIG));
  assert.deepEqual(t, ['A security interest in chattel paper may be perfected by filing.']);
});

test('译文角色：标题、正文、界面元素分得开', () => {
  const doc = mount(`<body>
    <h1>Perfection of security interests</h1>
    <p>A security interest may be perfected by filing.</p>
    <header><span>Search Cornell</span></header>
    <nav><span>Get the law</span></nav>
  </body>`);
  const units = scan(doc.body, LOOSE);
  const roles = Object.fromEntries(units.map((u) => [u.el.tagName, u.role]));
  assert.equal(roles.H1, 'heading', '标题角色判定错误');
  assert.equal(roles.P, 'body', '正文角色判定错误');
  assert.equal(roles.HEADER, 'ui', '页眉短文本应判为界面元素');
  // nav 现在在正文根这一层就被整体排除，压根不会产出单元
  assert.equal(roles.NAV, undefined, '导航应当在正文根阶段就被排除');

  // 标题要带上源字号，供 CSS 做 clamp 分级；正文不需要
  const heading = scan(mount(`<body><h1>Heading here</h1></body>`), LOOSE)[0];
  assert.equal(heading.role, 'heading');
});

test('页面背景计入 prompt 指纹，也进 system 的稳定段', () => {
  const base = { presetId: 'general', customPrompt: '', targetLang: '简体中文' };
  assert.notEqual(
    promptFingerprint({ ...base, background: '统一商法典条文' }),
    promptFingerprint({ ...base, background: '' }),
    '改了页面背景仍然命中旧缓存'
  );
  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'technical',
    targetLang: '简体中文',
    customPrompt: '保留英文缩写',
    background: '这是美国统一商法典条文'
  });
  assert.ok(system.includes('这是美国统一商法典条文'), '背景没有进入 prompt');
  assert.ok(
    system.indexOf('这是美国统一商法典条文') < system.indexOf('保留英文缩写'),
    '背景应排在自定义指令之前'
  );
});

test('纯文本摘要：层级保留、URL 去除、重复去重', () => {
  const units = [
    { text: 'Wayland', role: 'heading', tag: 'H1', mode: 'after' },
    { text: 'Wayland is a display server protocol.', role: 'body', tag: 'P', mode: 'after' },
    { text: 'Compositors', role: 'heading', tag: 'H2', mode: 'after' },
    { text: 'sway — i3-compatible compositor https://github.com/swaywm/sway', role: 'body', tag: 'LI', mode: 'append' },
    { text: 'sway — i3-compatible compositor https://github.com/swaywm/sway', role: 'body', tag: 'LI', mode: 'append' }
  ];
  const d = buildPlainDigest(units);
  const lines = d.text.split('\n');
  assert.equal(lines[0], '# Wayland');
  assert.equal(lines[2], '## Compositors');
  assert.ok(lines[3].startsWith('- sway'), '列表标记丢失');
  assert.ok(!d.text.includes('https://'), 'URL 未去除');
  assert.equal(lines.filter((l) => l.includes('sway')).length, 1, '重复行未去重');
});

test('纯文本摘要：超预算按结构采样而不是截断', () => {
  const units = [{ text: 'Intro', role: 'heading', tag: 'H1', mode: 'after' }];
  for (let i = 0; i < 30; i++) units.push({ text: `Paragraph number ${i} with some longer body text here.`, role: 'body', tag: 'P', mode: 'after' });
  units.push({ text: 'Troubleshooting', role: 'heading', tag: 'H2', mode: 'after' });
  units.push({ text: 'The stuttering issue appears after kernel update.', role: 'body', tag: 'P', mode: 'after' });
  const d = buildPlainDigest(units, { budget: 300 });
  assert.ok(d.sampled);
  assert.ok(d.text.includes('## Troubleshooting'), '文档尾部标题被截掉了');
  assert.ok(d.text.includes('stuttering'), '尾部章节正文被截掉了——采样退化成了截断');
  assert.ok(d.text.split('\n').filter((l) => l.startsWith('Paragraph')).length <= 2, '每节正文应只留前两段');
});

test('术语漂移检测：契约违约标出，遵约不误报', () => {
  const mk = (id, text, trans) => ({
    id, text, state: 'done', role: 'body',
    node: { isConnected: true, textContent: trans }
  });
  const units = [
    mk(1, 'The widget toolkit needs updating.', '部件工具包需要更新。'),
    mk(2, 'Each widget toolkit must support it.', '每个组件库都必须支持它。'),
    mk(3, 'No terms here at all.', '这里没有任何术语。')
  ];
  const hits = detectGlossaryDrift(units, { 'widget toolkit': '部件工具包' });
  assert.equal(hits.length, 1, `应恰好命中 1 处，实际 ${hits.length}`);
  assert.equal(hits[0].id, 2);
  // 已知限制：加字变体（小部件工具包）包含目标子串，抓不到——文档已写明
  const variant = [mk(4, 'A widget toolkit again.', '一个小部件工具包。')];
  assert.equal(detectGlossaryDrift(variant, { 'widget toolkit': '部件工具包' }).length, 0);
});

test('分批在标题处强制断开', () => {
  const u = (id, role, len) => ({ id, role, text: 'x'.repeat(len) });
  const chunks = buildChunks(
    [u(1, 'body', 40), u(2, 'body', 40), u(3, 'heading', 20), u(4, 'body', 40)],
    { maxChars: 500, maxItems: 20 }
  );
  assert.deepEqual(chunks.map((c) => c.map((x) => x.id)), [[1, 2], [3, 4]], '标题没有开启新批');
});

test('预检 prompt 本身要求 YAML，而不只是解析器碰巧能吃 YAML', () => {
  const { system } = buildPreflightMessages({ digest: 'x', context: {}, targetLang: '简体中文' });
  // 这条断言的由来：一次「改成 YAML」的替换静默失败，README 和测试都当它成功了，
  // 而当时的测试只验证 parsePreflightProfile 能解析 YAML —— 断言打在了错误的层级，
  // 于是"页面原则"这个功能在三个版本里从未真正生效过。
  assert.ok(/ONLY a YAML block/.test(system), '预检 prompt 没有要求 YAML');
  assert.ok(!/output ONE JSON object/.test(system), '预检 prompt 仍在要求 JSON');
  assert.ok(!/doc_type|entities/.test(system), '仍残留已废弃的 schema 字段');
  // 自动预检只有三个软分区：hard/原则/不翻只允许来自用户规则。
  for (const key of ['领域:', '优先:', '风险词:']) {
    assert.ok(system.includes(key), `预检 prompt 缺少分区：${key}`);
  }
  assert.ok(!system.includes('\n原则:'), '自动预检不应获得 page principle 权限');
  assert.ok(!system.includes('\n不翻:'), '自动预检不应获得 keep 权限');
  assert.ok(!system.includes('\n锁定:'), '自动预检不应获得 hard/锁定权限');
  // 风险词那一档绝不能要求给译法
  assert.ok(/NEVER put a .* translation here/.test(system), '风险词的约束没有写进 prompt');
});

test('预检输出解析：吃 YAML，也兼容 JSON', () => {
  // 现在要的就是用户在面板里看到、也能直接编辑的那套格式
  const fence = '`'.repeat(3);
  const yaml = [
    fence + 'yaml',
    '领域: Wayland, Linux 图形栈',
    '锁定:',
    '  compositor: 合成器',
    '优先:',
    '  widget toolkit: 部件工具包',
    '风险词:',
    '  output: 指显示输出设备，不是输出结果',
    '  stuttering: 画面卡顿掉帧，不是口吃',
    '不翻: commands, Xwayland',
    fence
  ].join('\n');
  const profile = parsePreflightProfile(yaml);
  assert.equal(profile.hard.compositor, '合成器');
  assert.equal(profile.preferred['widget toolkit'], '部件工具包');
  assert.equal(profile.risky.stuttering, '画面卡顿掉帧，不是口吃');
  assert.ok(profile.keep.includes('Xwayland'));

  // 模型偶尔回 JSON 也得认——fromYaml 本来就兼容
  const asJson = parsePreflightProfile('{"domain":["法律"],"hard":{"article":"编"}}');
  assert.equal(asJson.hard.article, '编');

  // 关键：空画像必须判为失败，不能谎报成功
  assert.equal(parsePreflightProfile(''), null);
  assert.equal(parsePreflightProfile('{}'), null, '空对象被当成了有效画像');
  assert.equal(parsePreflightProfile('这不是规则，只是一段废话'), null, '没得出规则却报了成功');

  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'technical', targetLang: '简体中文', profile
  });
  assert.ok(system.includes('LOCKED TERMS'), '硬约束段缺失');
  assert.ok(system.includes('compositor = 合成器'));
  assert.ok(system.includes('CONTEXT-SENSITIVE'), '风险词段缺失');
  // 风险词只标注不给译法——给了固定映射就会重演 stuttering→口吃
  const riskyLine = system.split('\n').find((l) => l.includes('CONTEXT-SENSITIVE'));
  assert.ok(!riskyLine.includes('='), '风险词不该带译法');

  const base = { presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '' };
  assert.notEqual(
    promptFingerprint({ ...base, profile }),
    promptFingerprint({ ...base, profile: null }),
    '画像未计入缓存指纹'
  );
});

test('模型输出解析：围栏、前后废话、转义、缺失项', () => {
  const ok = parseTranslationResponse(
    '```json\n{"items":[{"i":1,"t":"你好"},{"i":2,"t":"世界"}]}\n```',
    [1, 2]
  );
  assert.equal(ok.map.get(2), '世界');
  assert.equal(ok.missing.length, 0);

  const partial = parseTranslationResponse('好的：{"items":[{"i":1,"t":"仅一条"}]} 完毕', [1, 2, 3]);
  assert.deepEqual(partial.missing, [2, 3]);

  assert.equal(extractJsonObject('{"items":[{"i":1,"t":"含 } 与 \\" 的文本"}]}').items[0].t, '含 } 与 " 的文本');
  assert.equal(parseTranslationResponse('今天不想输出 JSON', [1]).parsed, false);
});

test('分批遵守字符与条数上限，超长单条独占一批', () => {
  const units = [
    { id: 1, text: 'a'.repeat(50) },
    { id: 2, text: 'b'.repeat(50) },
    { id: 3, text: 'c'.repeat(500) },
    { id: 4, text: 'd'.repeat(20) }
  ];
  const chunks = buildChunks(units, { maxChars: 120, maxItems: 2 });
  assert.deepEqual(chunks.map((c) => c.map((u) => u.id)), [[1, 2], [3], [4]]);
});

test('悬浮球：住在 Shadow DOM 里，站点 CSS 打不进来', () => {
  const doc = mount('<body><p>Some content here.</p></body>');
  const calls = [];
  fab.sync({ floatButton: true }, {
    translate: () => calls.push('translate'),
    preflight: () => calls.push('preflight'),
    clear: () => calls.push('clear'),
    state: () => ({ running: false, phase: 'idle' })
  });

  const host = doc.getElementById('byom-fab');
  assert.ok(host, '悬浮球没有挂上去');
  assert.ok(host.shadowRoot, '界面必须放进 Shadow DOM，否则站点 CSS 能打穿它');
  assert.equal(host.getAttribute('data-byom-skip'), '', '悬浮球必须被提取器跳过，否则会翻译自己');
  // 挂到 documentElement 而不是 body：body 上有 transform 会让 fixed 失效，
  // 单页应用清空 body 也会把我们一起扫掉
  assert.equal(host.parentNode, doc.documentElement, '应当挂在 documentElement 上');
  const styleText = host.shadowRoot.querySelector('style').textContent;
  assert.ok(styleText.includes('all:initial'), '没有切断站点样式继承');
  assert.ok(styleText.includes('position:static'), 'Shadow host 应保持 static，不应自己承担 fixed 定位');

  const root = host.shadowRoot;
  const shell = root.querySelector('.fab-shell');
  assert.ok(shell, '缺少承担 fixed 定位的内层 fab-shell');
  assert.ok(styleText.includes('.fab-shell') && styleText.includes('position: fixed'), 'fixed 定位没有移到内层 shell');
  const menu = root.querySelector('.menu');
  assert.equal(menu.hidden, true, '菜单默认应当收起');

  root.querySelector('.btn').click();
  assert.deepEqual(calls, ['translate']);

  root.querySelector('.btn').dispatchEvent(
    new doc.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  );
  assert.equal(menu.hidden, false, '右键没有展开菜单');
  menu.querySelector('[data-act="preflight"]').click();
  assert.deepEqual(calls, ['translate', 'preflight']);
  assert.equal(menu.hidden, true, '选完菜单项应当收起');

  fab.flash('还没填 API Key');
  const tip = root.querySelector('.tip');
  assert.equal(tip.hidden, false);
  assert.ok(tip.textContent.includes('API Key'));

  fab.sync({ floatPosition: 'middle' });
  assert.equal(host.dataset.pos, 'middle');
  fab.sync({ floatPosition: 'bottom', floatOffset: 40 });
  assert.equal(shell.style.top, '40vh', '拖动过的位置应当优先于预设档位');
  assert.equal(host.style.top, '', 'host 自己不应再承担 fixed/top 定位');

  // sync 是幂等的：关掉就拆干净，再开就回来
  fab.sync({ floatButton: false });
  assert.equal(doc.getElementById('byom-fab'), null, '关掉后节点应当移除');
  fab.sync({ floatButton: true }, { state: () => ({ running: false, phase: 'idle' }) });
  assert.ok(doc.getElementById('byom-fab'), '重新打开失败');
  fab.sync({ floatButton: false });
});

test('悬浮球被掏空成空壳时整体重建，而不是补挂一个空的', async () => {
  const doc = mount('<body><p>Content.</p></body>');
  fab.sync({ floatButton: true }, { state: () => ({ running: false, phase: 'idle' }) });
  const first = doc.getElementById('byom-fab');
  assert.ok(first.shadowRoot.querySelector('.btn'));

  // 宿主页面把 shadow 内容清了：节点还在，但已经是空壳
  first.shadowRoot.innerHTML = '';
  fab.sync({ floatButton: true });
  const rebuilt = doc.getElementById('byom-fab');
  assert.ok(rebuilt.shadowRoot.querySelector('.btn'), '空壳没有被重建，球在但点不动');
  fab.sync({ floatButton: false });
});

test('悬浮球被站点脚本清掉后会自己回来', async () => {
  const doc = mount('<body><p>Content.</p></body>');
  fab.sync({ floatButton: true }, { state: () => ({ running: false, phase: 'idle' }) });
  const host = doc.getElementById('byom-fab');
  assert.ok(host);

  // 单页应用重绘常常直接清空整棵子树
  host.remove();
  assert.equal(doc.getElementById('byom-fab'), null);

  await new Promise((r) => setTimeout(r, 30)); // MutationObserver 是异步的
  assert.ok(doc.getElementById('byom-fab'), '被清掉之后没有自动重挂');
  fab.sync({ floatButton: false });
});

test('悬浮球不会被提取器当成正文翻译', () => {
  const doc = mount('<body><p>Real content in the page.</p></body>');
  fab.sync({ floatButton: true }, { state: () => ({ running: false, phase: 'idle' }) });
  const t = texts(scan(doc.documentElement, LOOSE));
  assert.ok(!t.some((x) => x.includes('翻译本页') || x.includes('预检本页')), '悬浮球的菜单文字被当成正文了');
  assert.deepEqual(t, ['Real content in the page.']);
  fab.sync({ floatButton: false });
});

test('地址纠错：整条请求 URL 粘进来能自动收拾干净', () => {
  const openai = { defaultBase: 'https://api.openai.com/v1' };
  // 最常见的错法：从文档里把完整接口地址复制过来
  assert.equal(normalizeBase('https://api.deepseek.com/chat/completions', {}).value, 'https://api.deepseek.com');
  assert.equal(normalizeBase('https://api.openai.com/v1/chat/completions', openai).value, 'https://api.openai.com/v1');
  // 漏协议头、带引号、带尾斜杠
  assert.equal(normalizeBase('api.deepseek.com/', {}).value, 'https://api.deepseek.com');
  assert.equal(normalizeBase('"https://api.deepseek.com",', {}).value, 'https://api.deepseek.com');
  // 本地服务不能被强行加 https
  assert.equal(normalizeBase('localhost:11434/v1', {}).value, 'http://localhost:11434/v1');
  // 官方 base 带 /v1 而用户只填了域名时补上
  assert.equal(normalizeBase('https://api.openai.com', openai).value, 'https://api.openai.com/v1');
  // 自定义端点不瞎猜
  assert.equal(normalizeBase('https://my-gateway.internal/api', {}).value, 'https://my-gateway.internal/api');
  assert.ok(normalizeBase('api.deepseek.com', {}).note.includes('协议头'), '应当说明改了什么');
});

test('Key 软校验：提示但不拦截', () => {
  const anthropic = { keyPattern: '^sk-ant-', keyHint: 'sk-ant-…' };
  assert.equal(checkKey('', anthropic).level, 'empty');
  assert.equal(checkKey('sk-ant-abc123', anthropic).level, 'ok');
  assert.equal(checkKey('sk-abc123', anthropic).level, 'warn', '前缀不符应当提示');
  assert.ok(checkKey('sk-abc123', anthropic).message.includes('sk-ant-'), '提示里要给出正确格式');
  // 复制时带进来的空白最常见
  assert.ok(checkKey('sk-ant-abc 123', anthropic).message.includes('空格'));
  // 没有格式约定的服务商一律放行
  assert.equal(checkKey('anything', { keyPattern: '' }).level, 'ok');
});

test('模型清单：各家结构差异压平，噪音模型过滤掉', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), ['gpt-4o', 'gpt-4o-mini']);
  assert.deepEqual(parseModelList({ models: [{ name: 'llama3' }] }), ['llama3']);
  assert.deepEqual(parseModelList(['a', 'a', 'b']), ['a', 'b'], '应当去重');
  assert.deepEqual(parseModelList({}), []);

  const filtered = filterChatModels(['gpt-4o', 'text-embedding-3-small', 'whisper-1', 'dall-e-3']);
  assert.deepEqual(filtered, ['gpt-4o'], '嵌入/语音/图像模型不该出现在翻译模型列表里');
  // 全被过滤光时宁可原样返回，也不给空列表
  assert.deepEqual(filterChatModels(['whisper-1']), ['whisper-1']);
});

test('规则文本：往返不丢，容忍手写的松散格式', () => {
  const rules = {
    domain: ['法律', 'UCC'],
    hard: { article: '编', bailee: '受托保管人' },
    preferred: { 'new value': '新价值' },
    risky: { security: '担保权益语境，不是信息安全', interest: '此处指权益，不是利息' },
    keep: ['条文编号'],
    principle: ''
  };
  const round = fromYaml(toYaml(rules));
  assert.deepEqual(round, rules, '往返之后规则变了');

  // 用户手写常见的几种写法都要认
  const loose = fromYaml(`
领域: 法律
锁定:
   article: 编
   section:条
风险词: security, interest、shell
不翻:
- 条文编号
- 括号标号
`);
  assert.deepEqual(loose.hard, { article: '编', section: '条' }, '缩进和缺空格都该容忍');
  assert.deepEqual(Object.keys(loose.risky), ['security', 'interest', 'shell'], '裸列表写法仍要认');
  assert.deepEqual(loose.keep, ['条文编号', '括号标号']);

  // 技术术语里冒号很常见，不加引号往返即损坏。
  // 之前的往返测试全用 article、bailee 这类安全 key，所以一直没暴露。
  for (const term of ['std::vector', 'HTTP: header', 'ns::inner::type']) {
    const back = fromYaml(toYaml({ hard: { [term]: '译法' } }));
    assert.equal(back.hard[term], '译法', `带冒号的术语往返坏了：${term}`);
  }
  const risky = fromYaml(toYaml({ risky: { 'std::vector': '指容器模板，不是数学向量' } }));
  assert.equal(risky.risky['std::vector'], '指容器模板，不是数学向量');

  // 模型偶尔直接吐 JSON
  const asJson = fromYaml('{"domain":["法律"],"hard":{"article":"编"}}');
  assert.equal(asJson.hard.article, '编');
  // 英文键名也认
  assert.equal(fromYaml('hard:\n  article: 编').hard.article, '编');
  assert.ok(isEmptyRules(fromYaml('')));
  assert.ok(isEmptyRules(fromYaml('这不是规则，只是一段废话')));
});

test('风险词带义项：给义项不给译法，这是词典映射和放任之间唯一站得住的位置', () => {
  const withSense = fromYaml(`
风险词:
  output: 指显示输出设备，不是输出结果
  stuttering: 画面卡顿掉帧，不是口吃
  shell:
`);
  assert.equal(withSense.risky.output, '指显示输出设备，不是输出结果');
  assert.equal(withSense.risky.shell, '', '没写义项的词也要保留');

  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'technical',
    targetLang: '简体中文',
    profile: withSense
  });
  assert.ok(system.includes('here means: 画面卡顿掉帧'), '义项没有进入 prompt');
  assert.ok(system.includes('shell → ambiguous here'), '没写义项的词应当退回"按句判断"');
  // 关键约束：义项段里绝不能出现目标语言译法映射
  const seg = system.split('CONTEXT-SENSITIVE WORDS')[1].split('\n\n')[0];
  assert.ok(!/=/.test(seg), '风险词段出现了固定映射，会重演 stuttering→口吃');
});

test('领域不只是陈述，要带上"领域义压过日常义"的指令', () => {
  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'technical',
    targetLang: '简体中文',
    profile: fromYaml('领域: Wayland, Linux 图形栈')
  });
  assert.ok(system.includes('Wayland'), '领域没有进入 prompt');
  assert.ok(
    /domain-specific sense .* over its everyday sense/.test(system),
    '只说了领域是什么，没说拿它干什么——这样的领域行没有约束力'
  );
});

test('规则合并：用户写的压过模型猜的，冲突项自动清理', () => {
  const auto = {
    domain: ['Linux'],
    hard: { compositor: '合成器' },
    preferred: { bailee: '受托人' },
    risky: ['stuttering', 'bailee'],
    keep: ['commands']
  };
  const user = { hard: { bailee: '受托保管人' }, risky: { output: '此处指输出设备' }, domain: ['法律'] };
  const merged = mergeRules(auto, user);

  assert.equal(merged.hard.bailee, '受托保管人', '用户的锁定没有压过模型的优先项');
  assert.equal(merged.hard.compositor, '合成器', '模型那边没冲突的项应当保留');
  assert.ok(!('bailee' in merged.preferred), '同一个词不该同时出现在锁定和优先里');
  assert.ok(!('bailee' in merged.risky), '已经定死译法的词不该还留在风险词里');
  assert.ok('stuttering' in merged.risky && 'output' in merged.risky);
  assert.equal(merged.risky.output, '此处指输出设备', '用户写的义项应当保留');
  assert.deepEqual(merged.domain, ['法律', 'Linux'], '用户给的领域应当排在前面');
});

test('用户规则进入 prompt 且写明优先级', () => {
  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'general',
    targetLang: '简体中文',
    profile: mergeRules(null, fromYaml('锁定:\n  bailee: 受托保管人\n风险词: security'))
  });
  assert.ok(system.includes('bailee = 受托保管人'));
  assert.ok(system.includes('reader rules win'), '没有写明用户规则优先');
  assert.ok(system.includes('security → ambiguous here'), '风险词仍然不该带译法');
});

test('仅译文模式：列表项与单元格的原文也要能藏住', () => {
  const doc = mount(`<body><main>
    <p>A paragraph of body text goes here.</p>
    <ul><li>An item in a list here</li></ul>
    <table><tr><td>A table cell with text</td></tr></table>
  </main></body>`);
  const units = scan(doc.body, LOOSE);
  units.forEach((u) => {
    attach(u);
    fill(u, '【译】' + u.text.slice(0, 6));
  });

  // 元素级用 data-byom-src 整个藏掉；append 型（译文在内部）用 data-byom-src-in 压字号。
  // 之前 append 型被整个跳过，列表和表格的原文全留着，看起来就像设置没生效。
  const hideable = doc.querySelectorAll('[data-byom-src],[data-byom-src-in]').length;
  assert.equal(hideable, units.length, `${units.length} 个单元里只有 ${hideable} 个能藏住原文`);

  const li = doc.querySelector('li');
  assert.equal(li.dataset.byomSrcIn, '', 'LI 没有被标记为可隐藏');
  assert.ok(
    li.querySelector('.byom-t').style.getPropertyValue('--byom-own-size'),
    '没有记下原始字号，压字号之后译文会跟着变成 0'
  );
});

test('清除译文不该把显示方式这个设置一起重置', () => {
  const doc = mount('<body><main><p>Some text to translate.</p></main></body>');
  scan(doc.body, LOOSE).forEach((u) => (attach(u), fill(u, '【译】x')));
  applyPresentation({ displayMode: 'translation' });
  assert.equal(doc.documentElement.dataset.byomDisplay, 'translation');

  removeAll();
  assert.equal(doc.querySelectorAll('.byom-t').length, 0, '译文没清干净');
  assert.equal(doc.querySelectorAll('[data-byom-src-in]').length, 0, '隐藏标记没清干净');
  assert.equal(
    doc.documentElement.dataset.byomDisplay,
    'translation',
    '清一次译文就悄悄退回双语——看起来就像预设值失效了'
  );
});

test('服务商元信息：Key 格式跟得上厂商变更，特殊请求头带得出去', () => {
  const gemini = listProviders().find((p) => p.id === 'gemini');
  // Google 已把 Key 换成 AQ. 开头，旧的 AIza 2026 年 9 月停用。
  // 只认 ^AIza 会把现行的 Key 全报成错的。
  assert.ok(new RegExp(gemini.keyPattern).test('AQ.Ab8RN6I2qSs'), '新格式 Key 被误判为错误');
  assert.ok(new RegExp(gemini.keyPattern).test('AIzaSyXXXX'), '旧格式仍要认');

  const or = listProviders().find((p) => p.id === 'openrouter-free');
  // 免费模型不带这两个头会直接 402，而报错信息看不出原因
  assert.ok(or.extraHeaders?.['HTTP-Referer'], '缺少 HTTP-Referer');
  assert.ok(or.extraHeaders?.['X-Title'], '缺少 X-Title');
});

test('页面原则是祈使句，单独成档且写明压过通用领域指导', () => {
  const rules = fromYaml('原则: 命令与参数原样保留，说明性语气不做润色\n领域: Linux 图形栈');
  assert.equal(rules.principle, '命令与参数原样保留，说明性语气不做润色');

  // 旧存量文本里的"摘要"仍要能解析，否则用户存下的规则会静默丢一行
  assert.equal(fromYaml('摘要: 旧文本').principle, '旧文本');

  const { system } = buildMessages({
    items: [{ i: 1, text: 'x' }],
    presetId: 'technical',
    targetLang: '简体中文',
    profile: rules
  });
  assert.ok(system.includes('命令与参数原样保留'), '原则没有进 prompt');
  assert.ok(
    /PAGE-SPECIFIC PRINCIPLE .*takes precedence/.test(system),
    '没有写明页面原则压过 preset 的通用领域指导'
  );

  const html = renderRulesTree(rules, buildSources({ auto: rules, user: null }));
  assert.ok(html.includes('rt-principle'), '原则没有单独成档');
  assert.ok(html.indexOf('rt-principle') < html.indexOf('rt-domain'), '原则应当排在最前');
});

test('规则树：六档分区、来源标记、风险词与锁定项视觉可分', () => {
  const auto = fromYaml('领域: Wayland\n锁定:\n  compositor: 合成器\n风险词:\n  output: 显示输出设备');
  const user = fromYaml('锁定:\n  bailee: 受托保管人');
  const merged = mergeRules(auto, user);
  const html = renderRulesTree(merged, buildSources({ auto, user }));

  assert.ok(html.includes('compositor') && html.includes('合成器'));
  assert.ok(html.includes('rt-risky'), '风险词没有独立分区');
  assert.ok(html.includes('显示输出设备'), '义项没有显示出来');
  // 两种来源必须分得开，否则"这个词为什么这么翻"答不上来
  assert.ok(/data-src="user"[^>]*>\s*<code[^>]*>bailee/.test(html.replace(/\n/g, '')), '用户规则没有标出来源');
  assert.ok(html.includes('data-src="auto"'), '自动判定没有标出来源');

  // 空规则要给出可操作的说明，而不是一片空白
  assert.ok(renderRulesTree({}, null).includes('当前没有额外翻译约束'));
  // 用户输入进 HTML 前必须转义
  assert.ok(renderRulesTree(fromYaml('锁定:\n  <img src=x>: 危险'), null).includes('&lt;img'));
});

test('链接密度：几乎全是短链接的容器判为导航，正文里的链接不受影响', () => {
  const doc = mount('<body></body>');
  const make = (html) => {
    const d = doc.createElement('div');
    d.innerHTML = html;
    return d;
  };
  assert.equal(
    isLinkList(make('<a href="/">Home</a><a href="/p">Packages</a><a href="/f">Forums</a><a href="/w">Wiki</a>')),
    true,
    '纯短链接列表应当判为导航'
  );
  // 正文段落里也有链接，但占比低、条目长
  assert.equal(
    isLinkList(
      make(
        'Wayland is a <a href="/x">display server protocol</a> widely established as the successor of the ' +
          '<a href="/y">X Window System</a>. You can find a comparison on Wikipedia and elsewhere in the docs.'
      )
    ),
    false,
    '正文里的链接不该被判成导航'
  );
  assert.equal(isLinkList(make('<a href="/">Only one</a>')), false, '链接太少不构成导航');
});

test('页面分类：域名表、站点规则、结构特征', () => {
  mount(
    `<body><h1>Interconnect design</h1><pre>a</pre><pre>b</pre><pre>c</pre></body>`,
    'https://blog.unknown-site.net/post'
  );
  assert.equal(classifyPage(collectPageContext(), []).presetId, 'technical'); // 代码块特征
  assert.equal(classifyPage({ hostname: 'arxiv.org' }, []).presetId, 'academic');
  assert.equal(classifyPage({ hostname: 'www.reuters.com' }, []).presetId, 'news');
  assert.equal(classifyPage({ hostname: 'old.reddit.com' }, []).presetId, 'forum');
  assert.equal(classifyPage({ hostname: 'random.site' }, []).presetId, 'general');
  assert.equal(
    classifyPage({ hostname: 'wiki.corp.io' }, [{ host: 'wiki.corp.io', presetId: 'academic' }]).presetId,
    'academic'
  );
});

/* ------------------------------------------------------------------ */

mount('<body></body>'); // 先给模块一个可用的 document
({ scan, resetIds, collectPageContext } = await import('../src/content/extractor.js'));
({ attach, fill, applyPresentation, removeAll } = await import('../src/content/renderer.js'));
({ listProviders } = await import('../src/shared/provider-catalog.js'));
({ buildChunks } = await import('../src/content/chunker.js'));
({ parseTranslationResponse, extractJsonObject } = await import('../src/prompt/build.js'));
({ classifyPage } = await import('../src/prompt/classify.js'));
({ promptFingerprint, buildMessages, parsePreflightProfile, buildPreflightMessages } =
  await import('../src/prompt/build.js'));
({ buildPlainDigest } = await import('../src/content/digest.js'));
({ detectGlossaryDrift } = await import('../src/content/quality.js'));
fab = await import('../src/content/float-widget.js');
({ normalizeBase, checkKey, parseModelList, filterChatModels } = await import('../src/shared/provider-help.js'));
({ toYaml, fromYaml, mergeRules, isEmptyRules } = await import('../src/shared/rules-yaml.js'));
({ renderRulesTree, buildSources } = await import('../src/shared/rules-tree.js'));
({ isLinkList } = await import('../src/content/content-root.js'));
({ cacheKey } = await import('../src/background/cache.js'));
({ Queue } = await import('../src/background/queue.js'));

let failed = 0;
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
