/** CSS 可见性与回填必须在真实布局引擎验收。使用合成页面，不连接真实课程站点或翻译服务。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = process.env.JT_LAYOUT_ROOT || fileURLToPath(new URL('../', import.meta.url));
const config = { minTextLength: 2, smartFilter: true, contentRootOnly: true, targetLang: '简体中文' };

async function serveModules() {
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><link rel="stylesheet" href="/assets/content.css"></head><body></body></html>');
      return;
    }
    const path = resolve(root, '.' + req.url);
    if (!path.startsWith(resolve(root) + sep) || !/\.(js|css)$/.test(path)) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('Chromium 中提取可见正文并保持回填归属', { timeout: 60000 }, async t => {
  const server = await serveModules();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({
    executablePath: process.env.JT_CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--disable-gpu']
  });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.diagnostic(`Chromium ${browser.version()}；合成 DOM，未验证真实课程页面`);

  await t.test('无盒子容器、误用语义、根外正文与折叠后展开', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const result = await page.evaluate(async cfg => {
        const { scan, inspectExtraction } = await import('/src/content/extractor.js');
        document.body.innerHTML = `<nav><a>Course home</a><a>Course tools</a></nav>
          <main style="display:contents" role="presentation"><section role="none">
            <h2>Course instructions</h2><aside class="sidebar">
              <odd-wrapper><p>Take notes during class and ask your peers for help.</p>
                <ul><li>Please be respectful.</li></ul></odd-wrapper>
            </aside></section></main>
          <article><p>Further instructions outside the first main element.</p></article>
          <div style="display:none"><p>Hidden draft must not be sent.</p></div>
          <div style="content-visibility:hidden"><p>Another hidden draft must not be sent.</p></div>
          <details><summary>More information</summary><p>Content revealed by expanding the section.</p></details>`;
        const before = scan(document.body, cfg, { snapshot: true }).map(unit => unit.text);
        const boxless = document.querySelector('main').checkVisibility();
        const details = document.querySelector('details');
        details.open = true;
        const after = scan(document.body, cfg, { snapshot: true }).map(unit => unit.text);
        return { before, after, boxless, stats: inspectExtraction(document.body, cfg) };
      }, config);
      assert.equal(result.boxless, false, '真实 checkVisibility 应暴露 display:contents 的区别');
      assert.deepEqual(result.before, [
        'Course instructions', 'Take notes during class and ask your peers for help.',
        'Please be respectful.', 'Further instructions outside the first main element.', 'More information'
      ]);
      assert.deepEqual(result.after, [...result.before, 'Content revealed by expanding the section.']);
      assert.equal(result.stats.completed, true);
      assert.equal(result.stats.skippedElements.hidden, 2);
    } finally { await page.close(); }
  });

  await t.test('flex/grid 不增添布局子项，翻译显示模式和响应式切换后仍收敛', async () => {
    for (const display of ['flex', 'grid']) {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      try {
        await page.goto(origin);
        const result = await page.evaluate(async ({ cfg, display }) => {
          const { scan, inspectExtraction } = await import('/src/content/extractor.js');
          const render = await import('/src/content/renderer.js');
          document.body.innerHTML = `<main style="display:${display};gap:24px;grid-template-columns:1fr 1fr">
            <section style="display:contents"><p>Please be respectful.</p><p>Keep your notes.</p></section></main>`;
          const units = scan(document.body, cfg);
          units.forEach(unit => { render.attach(unit); render.fill(unit, '请保留课堂笔记。'); });
          const main = document.querySelector('main');
          const childCount = main.querySelector('section').children.length;
          const noDuplicate = scan(document.body, cfg).length;
          render.setDisplayMode('translation');
          const snapshot = inspectExtraction(document.body, cfg);
          const mode = document.documentElement.dataset.byomDisplay;
          const translationHeights = units.map(unit => unit.node.getBoundingClientRect().height);
          main.style.display = 'block';
          const afterLayoutChange = scan(document.body, cfg).length;
          render.removeAll();
          return {
            texts: units.map(unit => unit.text), childCount, noDuplicate, snapshot, mode,
            translationHeights, afterLayoutChange,
            remaining: document.querySelectorAll('.byom-t,[data-byom-src-in]').length
          };
        }, { cfg: config, display });
        assert.deepEqual(result.texts, ['Please be respectful.', 'Keep your notes.']);
        assert.equal(result.childCount, 2);
        assert.equal(result.noDuplicate, 0);
        assert.equal(result.snapshot.candidateUnits, 2);
        assert.equal(result.snapshot.existingTranslationUnits, 2);
        assert.equal(result.mode, 'translation');
        assert.ok(result.translationHeights.every(height => height > 0));
        assert.equal(result.afterLayoutChange, 0);
        assert.equal(result.remaining, 0);
      } finally { await page.close(); }
    }
  });

  await t.test('开放组件进入诊断，iframe 与明确跳过内容仍不冒充已覆盖', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const result = await page.evaluate(async cfg => {
        const { inspectExtraction } = await import('/src/content/extractor.js');
        document.body.innerHTML = `<p>Visible top level course text.</p><course-content></course-content>
          <iframe srcdoc="<p>Frame course body.</p>"></iframe>
          <div data-byom-skip><own-content></own-content></div>`;
        document.querySelector('course-content').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow course body.</p>';
        document.querySelector('own-content').attachShadow({ mode: 'open' }).innerHTML = '<p>Extension controls.</p>';
        return inspectExtraction(document.body, cfg);
      }, config);
      assert.equal(result.candidateUnits, 2);
      assert.equal(result.frameBoundaries, 1);
      assert.equal(result.openShadowHosts, 1);
      assert.equal(result.scope, 'top-document-open-shadow-dom');
      assert.ok(!JSON.stringify(result).includes('course body'));
    } finally { await page.close(); }
  });

  await t.test('Brightspace 同结构的正文可见，嵌套根共用样式与显示模式', async () => {
    const page = await browser.newPage();
    const errors = [];
    let cssFetches = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.resourceType() === 'fetch' && request.url().endsWith('/assets/content.css')) cssFetches++;
    });
    try {
      await page.goto(origin);
      const result = await page.evaluate(async cfg => {
        const { scan, inspectExtraction } = await import('/src/content/extractor.js');
        const render = await import('/src/content/renderer.js');
        const { ensureShadowStyles } = await import('/src/content/shadow-styles.js');
        document.body.innerHTML = '<main><h1>Discussion Forum</h1><course-content></course-content></main>';
        const host = document.querySelector('course-content');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>:host {display:block;overflow-x:auto;overflow-y:hidden}
          .d2l-html-block-rendered {font:19px sans-serif} p {margin:1em 0}</style>
          <div class="d2l-html-block-rendered"><p>Please take notes during class.</p>
          <p>Ask <strong>your peers</strong> when you miss a class.</p>
          <ul><li>Keep discussions respectful.</li></ul><nested-content></nested-content></div>`;
        const nested = shadow.querySelector('nested-content').attachShadow({ mode: 'open' });
        nested.innerHTML = '<p>Contact the teaching assistant for course questions.</p>';
        // 样式通过本地文件读取并构建，不依赖站点允许新插入 style/link。
        const policy = document.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "style-src 'none'";
        document.head.append(policy);
        render.applyPresentation({ translationStyle: 'bar', translationColor: 'accent',
          accentColorLight: '#b55010', accentColorDark: '#e89960' });
        const units = scan(document.body, cfg);
        units.forEach(unit => { render.attach(unit); render.fill(unit, '请保留课堂笔记，并尊重同学。'); });
        await Promise.all(units.map(unit => ensureShadowStyles(unit.node)));
        const inner = units.filter(unit => unit.node.getRootNode().host);
        const visible = inner.map(unit => ({
          height: unit.node.getBoundingClientRect().height,
          border: getComputedStyle(unit.node).borderLeftWidth,
          color: getComputedStyle(unit.node).color,
          display: getComputedStyle(unit.node).display
        }));
        const sharedSheet = shadow.adoptedStyleSheets[0] === nested.adoptedStyleSheets[0];
        render.setDisplayMode('original');
        const hidden = inner.every(unit => getComputedStyle(unit.node).display === 'none');
        render.setDisplayMode('translation');
        const onlyTranslations = inner.every(unit => unit.node.getBoundingClientRect().height > 0);
        const hiddenSources = inner.filter(unit => unit.mode === 'after')
          .every(unit => getComputedStyle(unit.el).display === 'none');
        const snapshot = inspectExtraction(document.body, cfg);
        const stillTranslation = render.displayMode();
        const duplicates = scan(document.body, cfg).length;
        document.documentElement.dataset.byomStyle = 'underline';
        const underlines = inner.every(unit => getComputedStyle(unit.node).borderBottomStyle === 'dashed');
        inner.forEach(unit => { unit.node.dataset.byomDrift = ''; });
        render.clearDriftMarks();
        const clearedDrift = inner.every(unit => !unit.node.hasAttribute('data-byom-drift'));
        render.removeAll();
        const clean = [document, shadow, nested].every(root =>
          !root.querySelector('.byom-t,[data-byom-src],[data-byom-src-in]'));
        return { texts: units.map(unit => unit.text), visible, sharedSheet, hidden, onlyTranslations,
          hiddenSources, snapshot, stillTranslation, duplicates, underlines, clearedDrift, clean,
          sheetsAfterClear: shadow.adoptedStyleSheets.length + nested.adoptedStyleSheets.length,
          afterClear: scan(document.body, cfg).length };
      }, config);
      assert.equal(result.texts.length, 5);
      assert.equal(result.visible.length, 4);
      assert.ok(result.visible.every(style => style.height > 0 && style.border === '2px' && style.display === 'block'));
      assert.ok(result.visible.every(style => style.color === 'rgb(181, 80, 16)'));
      assert.equal(cssFetches, 1, '所有组件只读取一次本地 CSS');
      for (const key of ['sharedSheet', 'hidden', 'onlyTranslations', 'hiddenSources', 'underlines', 'clearedDrift', 'clean']) {
        assert.equal(result[key], true, key);
      }
      assert.equal(result.snapshot.candidateUnits, 5);
      assert.equal(result.snapshot.existingTranslationUnits, 5);
      assert.equal(result.stillTranslation, 'translation');
      assert.equal(result.duplicates, 0);
      assert.equal(result.sheetsAfterClear, 0);
      assert.equal(result.afterClear, 5);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test('真实插槽投影、延迟正文和重绘后仍能去重，内部双击可找到单元', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const result = await page.evaluate(async cfg => {
        const { scan } = await import('/src/content/extractor.js');
        const render = await import('/src/content/renderer.js');
        const { ensureShadowStyles } = await import('/src/content/shadow-styles.js');
        const { createMutationWatcher } = await import('/src/content/observer.js');
        const tick = () => new Promise(resolve => setTimeout(resolve, 60));
        document.body.innerHTML = `<main><course-content><p slot="body">Assigned course paragraph.</p>
          <p>Unassigned draft must not be sent.</p></course-content></main>`;
        const host = document.querySelector('course-content');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>:host{display:contents}</style><div class="d2l-html-block-rendered"></div>';
        let dirty = 0;
        const watcher = createMutationWatcher(() => dirty++, { debounceMs: 5 });
        watcher.start();
        try {
          shadow.querySelector('div').innerHTML = '<p>Deferred course paragraph.</p><slot name="body"></slot>';
          await tick();
          const afterLoad = dirty;
          const units = scan(document.body, cfg);
          units.forEach(unit => { render.attach(unit); render.fill(unit, '译文正文。'); });
          await Promise.all(units.map(unit => ensureShadowStyles(unit.node)));
          await tick();
          const afterFill = dirty;
          const heights = units.map(unit => unit.node.getBoundingClientRect().height);
          const duplicates = scan(document.body, cfg).length;
          let found = null;
          document.addEventListener('dblclick', event => { found = render.findUnitIdFromEvent(event); }, { once: true });
          const internal = units.find(unit => unit.node.getRootNode() === shadow);
          internal.node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, composed: true }));
          shadow.querySelector('div').innerHTML = '<p>Replaced course paragraph.</p><slot name="body"></slot>';
          await tick();
          const afterRedraw = dirty;
          const newTexts = scan(document.body, cfg).map(unit => unit.text);
          watcher.stop();
          shadow.querySelector('p').textContent = 'Change after stopping.';
          await tick();
          render.removeAll();
          return { texts: units.map(unit => unit.text), heights, duplicates, found, expectedId: internal.id,
            afterLoad, afterFill, afterRedraw, afterStop: dirty, newTexts,
            clean: !shadow.querySelector('.byom-t') && !host.querySelector('.byom-t') };
        } finally { watcher.stop(); }
      }, config);
      assert.deepEqual(result.texts, ['Deferred course paragraph.', 'Assigned course paragraph.']);
      assert.ok(result.heights.every(height => height > 0));
      assert.equal(result.duplicates, 0);
      assert.equal(result.found, result.expectedId);
      assert.equal(result.afterLoad, 1);
      assert.equal(result.afterFill, 1);
      assert.equal(result.afterRedraw, 2);
      assert.equal(result.afterStop, 2);
      assert.deepEqual(result.newTexts, ['Replaced course paragraph.']);
      assert.equal(result.clean, true);
    } finally { await page.close(); }
  });

  await t.test('清除时尚未返回的本地 CSS 不得重新挂回组件', async () => {
    const page = await browser.newPage();
    let release;
    let requested;
    const waiting = new Promise(resolve => { requested = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/assets/content.css', async route => {
      if (route.request().resourceType() === 'fetch') { requested(); await gate; }
      await route.continue();
    });
    try {
      await page.goto(origin);
      const pending = page.evaluate(async cfg => {
        const { scan } = await import('/src/content/extractor.js');
        const render = await import('/src/content/renderer.js');
        const { ensureShadowStyles } = await import('/src/content/shadow-styles.js');
        document.body.innerHTML = '<course-content></course-content>';
        const shadow = document.querySelector('course-content').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<p>Deferred style test paragraph.</p>';
        const [unit] = scan(document.body, cfg);
        render.attach(unit);
        const stylesReady = ensureShadowStyles(unit.node);
        render.removeAll();
        await stylesReady;
        const afterCancel = shadow.adoptedStyleSheets.length;
        const [next] = scan(document.body, cfg);
        render.attach(next); render.fill(next, '重新开始后的译文。');
        await ensureShadowStyles(next.node);
        return { afterCancel, afterRestart: shadow.adoptedStyleSheets.length,
          visible: next.node.getBoundingClientRect().height > 0 };
      }, config);
      await waiting;
      release();
      const result = await pending;
      assert.equal(result.afterCancel, 0);
      assert.equal(result.afterRestart, 1);
      assert.equal(result.visible, true);
    } finally { release(); await page.close(); }
  });
});
