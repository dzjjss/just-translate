import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function mount(html = '<main><h1>Discussion Forum</h1><course-block></course-block></main>') {
  const dom = new JSDOM(html, { url: 'https://course.example.test/discussion' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  return dom;
}

mount();
const { scan, inspectExtraction, resetIds } = await import('../src/content/extractor.js');
const render = await import('../src/content/renderer.js');
const { createMutationWatcher } = await import('../src/content/observer.js');
const cfg = { minTextLength: 2, smartFilter: true, contentRootOnly: true, targetLang: '简体中文' };
const texts = units => units.map(unit => unit.text);
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const cases = [];
const test = (name, run) => cases.push([name, run]);

test('Brightspace 同结构：异步容器里的段落与列表全部进入同一组单元', () => {
  mount();
  const root = document.querySelector('course-block').attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="d2l-html-block-rendered"><p>Please take notes during class.</p>
    <p>Ask <strong>your peers</strong> when you miss a class.</p>
    <ul><li>Keep discussions respectful.</li></ul></div>`;
  const units = scan(document.body, cfg);
  assert.deepEqual(texts(units), [
    'Discussion Forum', 'Please take notes during class.',
    'Ask your peers when you miss a class.', 'Keep discussions respectful.'
  ]);
  units.forEach(unit => { render.attach(unit); render.fill(unit, '译文：' + unit.text); });
  assert.equal(root.querySelectorAll('.byom-t').length, 3);
  assert.equal(scan(document.body, cfg).length, 0);
  const before = document.body.innerHTML;
  const snapshot = inspectExtraction(document.body, cfg);
  assert.equal(snapshot.candidateUnits, 4);
  assert.equal(snapshot.existingTranslationUnits, 4);
  assert.equal(snapshot.openShadowHosts, 1);
  assert.equal(document.body.innerHTML, before);
  render.removeAll();
  assert.equal(root.querySelectorAll('.byom-t,[data-byom-src],[data-byom-src-in]').length, 0);
  assert.equal(scan(document.body, cfg).length, 4);
});

test('按插槽的渲染顺序遍历，未分配内容不翻，原文与回填不重复', () => {
  mount(`<main><course-block><p slot="body">Assigned course paragraph.</p>
    <p>Unassigned draft must not be translated.</p></course-block></main>`);
  const host = document.querySelector('course-block');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<h2>Course information</h2><slot name="body"></slot><slot name="fallback"><p>Fallback paragraph.</p></slot>';
  const units = scan(document.body, cfg);
  assert.deepEqual(texts(units), ['Course information', 'Assigned course paragraph.', 'Fallback paragraph.']);
  units.forEach(unit => { render.attach(unit); render.fill(unit, 'Translated paragraph.'); });
  assert.ok(host.querySelector('p[slot="body"] > .byom-t'), '译文必须留在原插槽的元素内部');
  assert.equal(scan(document.body, cfg).length, 0);
  render.removeAll();
  assert.equal(root.querySelectorAll('.byom-t').length + host.querySelectorAll('.byom-t').length, 0);
});

test('嵌套组件与宿主的明确跳过边界保持一致', () => {
  mount('<main><course-block></course-block><course-private translate="no"></course-private></main>');
  const root = document.querySelector('course-block').attachShadow({ mode: 'open' });
  root.innerHTML = '<p>Visible outer paragraph.</p><inner-course></inner-course><div hidden><hidden-course></hidden-course></div>';
  root.querySelector('inner-course').attachShadow({ mode: 'open' }).innerHTML =
    '<p>Visible inner paragraph.</p><div contenteditable="true"><p>Private draft.</p></div>';
  root.querySelector('hidden-course').attachShadow({ mode: 'open' }).innerHTML = '<p>Hidden paragraph.</p>';
  document.querySelector('course-private').attachShadow({ mode: 'open' }).innerHTML = '<p>Excluded paragraph.</p>';
  assert.deepEqual(texts(scan(document.body, cfg)), ['Visible outer paragraph.', 'Visible inner paragraph.']);
  assert.equal(inspectExtraction(document.body, cfg).openShadowHosts, 2);
});

test('组件内部异步正文、重绘和新嵌套根触发同一观察器，停止后不再回调', async () => {
  mount();
  const root = document.querySelector('course-block').attachShadow({ mode: 'open' });
  let dirty = 0;
  const watcher = createMutationWatcher(() => dirty++, { debounceMs: 1 });
  watcher.start();
  try {
    root.innerHTML = '<div class="d2l-html-block-rendered"><p>Deferred course text.</p></div>';
    await tick();
    assert.equal(dirty, 1, '正文只在 Shadow DOM 内出现也必须触发');
    const units = scan(document.body, cfg);
    units.forEach(unit => { render.attach(unit); render.fill(unit, '译文'); });
    await tick();
    assert.equal(dirty, 1, '扩展自己的回填不能产生扫描循环');
    root.querySelector('.d2l-html-block-rendered').innerHTML = '<p>Replaced course text.</p><nested-course></nested-course>';
    const nested = root.querySelector('nested-course').attachShadow({ mode: 'open' });
    nested.innerHTML = '<p>New nested content.</p>';
    await tick();
    assert.equal(dirty, 2);
    nested.querySelector('p').textContent = 'Edited nested content.';
    await tick();
    assert.equal(dirty, 3, '新根必须加入监听');
    assert.ok(texts(scan(document.body, cfg)).includes('Edited nested content.'));
    root.querySelector('nested-course').remove();
    await tick();
    const afterRemoval = dirty;
    nested.querySelector('p').textContent = 'Detached content.';
    await tick();
    assert.equal(dirty, afterRemoval, '移除的根不应继续监听');
    watcher.stop();
    root.querySelector('p').textContent = 'Stopped content.';
    await tick();
    assert.equal(dirty, afterRemoval);
  } finally { watcher.stop(); }
});

test('插槽变化和用户交互可发现延迟附加的根，不使用轮询或页面原型补丁', async () => {
  mount();
  let dirty = 0;
  const watcher = createMutationWatcher(() => dirty++, { debounceMs: 1 });
  watcher.start();
  try {
    const root = document.querySelector('course-block').attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Expand details</button><slot></slot>';
    root.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
    await tick();
    assert.equal(dirty, 1);
    root.querySelector('slot').dispatchEvent(new window.Event('slotchange', { bubbles: true }));
    await tick();
    assert.equal(dirty, 2, 'slotchange 不越过 Shadow 边界，必须在根上监听');
  } finally { watcher.stop(); }
});

test('内部译文双击使用 composedPath 找到原单元', () => {
  mount();
  const host = document.querySelector('course-block');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<p>Course notes to translate.</p>';
  const unit = scan(document.body, cfg).find(unit => unit.el.getRootNode() === root);
  assert.ok(unit, '缺少内部单元');
  render.attach(unit); render.fill(unit, '课程笔记');
  let found = null;
  document.addEventListener('dblclick', event => {
    assert.equal(event.target, host, '外层看到的是宿主');
    found = render.findUnitIdFromEvent(event);
  }, { once: true });
  unit.node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, composed: true }));
  assert.equal(found, unit.id);
});

let failed = 0;
for (const [name, run] of cases) {
  try { resetIds(); await run(); console.log('  ✓', name); }
  catch (error) { failed++; console.error('  ✗', name, '\n   ', error.stack || error); }
}
console.log(failed ? `${failed} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
