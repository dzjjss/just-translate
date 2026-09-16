/** Real Chromium with local assets and mocked Chrome APIs. No provider or public-page requests. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

async function popup(browser, { scale = 1, locale = 'en-US', saved = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 600 }, deviceScaleFactor: scale, locale });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (url.origin !== 'http://jt-popup.test' || !file.startsWith(root)) return route.abort();
    try { await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] || 'text/plain' }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await context.addInitScript(({ manifest, saved, locale }) => {
    let settings = saved;
    window.__requests = [];
    window.chrome = {
      i18n: { getUILanguage: () => locale, detectLanguage: () => { throw Error('Unexpected language detection'); } },
      storage: { local: { get: async () => ({ settings }), set: async value => { settings = value.settings; } }, onChanged: { addListener() {} } },
      runtime: {
        getManifest: () => manifest,
        onMessage: { addListener() {} },
        sendMessage: async msg => {
          window.__requests.push(msg.type);
          if (msg.type === 'query-tab') return { ok: true, tabId: 5, url: 'https://example.test/article', injectable: true, injected: false };
          if (msg.type === 'save-settings') {
            settings = { ...settings, ...msg.payload.patch, configVersion: (settings.configVersion || 0) + 1 };
            return { ok: true, settings };
          }
          if (msg.type === 'list-models') return { ok: true, ids: ['model-alpha', 'model-beta', 'x'.repeat(200)] };
          return { ok: true };
        }
      },
      permissions: { contains: async () => true, request: async () => true,
        onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
      tabs: { sendMessage: async () => ({ ok: true }) }
    };
  }, { manifest, saved, locale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://jt-popup.test/src/popup/popup.html');
  await page.waitForFunction(() => document.getElementById('ver').textContent !== 'v–');
  return { page, context, errors };
}

test('用户语言与原生模型菜单在 Chromium 中可用', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.JT_CHROMIUM_PATH || undefined,
    headless: true, args: ['--disable-gpu'] });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()}; local assets / mocked extension APIs`);

  await t.test('不同像素密度下显示完整列表，长模型 ID 不撑破布局', async () => {
    for (const scale of [1, 1.5, 2]) {
      const { page, context, errors } = await popup(browser, { scale, saved: {
        schemaVersion: 13, targetLang: 'English', apiKey: 'sk-fixture', model: 'private-saved-model'
      } });
      try {
        await page.locator('#openSettings').click();
        await page.locator('#fetchModels').click();
        await page.waitForFunction(() => document.querySelector('#modelNote').textContent.includes('Fetched 3'));
        assert.equal(await page.locator('#model').inputValue(), 'private-saved-model');
        for (const id of ['model-alpha', 'model-beta', 'private-saved-model']) {
          assert.equal(await page.locator('#model option').evaluateAll((items, id) => items.some(i => i.value === id), id), true);
        }
        await page.locator('#model').selectOption('x'.repeat(200));
        const box = await page.evaluate(() => ({
          width: document.body.getBoundingClientRect().width,
          overflow: document.querySelector('.popup-scroll').scrollWidth - document.querySelector('.popup-scroll').clientWidth,
          select: document.getElementById('model').getBoundingClientRect().width
        }));
        assert.equal(box.width, 420);
        assert.ok(box.overflow <= 1, `横向溢出 ${box.overflow}px`);
        assert.ok(box.select > 120 && box.select < 350);
        await page.locator('#model').selectOption('__jt_custom_model__');
        await page.locator('#customModel').fill('self-hosted:latest');
        assert.equal(await page.locator('#customModel').isVisible(), true);
        assert.equal(await page.locator('#applyModel').isEnabled(), true);
        await page.locator('#closeSettings').click();
        await page.locator('#targetLang').selectOption('简体中文');
        await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
        await page.locator('#openSettings').click();
        assert.equal(await page.locator('#customModel').inputValue(), 'self-hosted:latest');
        assert.equal(await page.locator('#apiKey').inputValue(), 'sk-fixture');
        assert.equal(await page.locator('#apiKey').getAttribute('type'), 'password');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });

  await t.test('英文首次安装和未知环境语言都有可达的语言选择入口', async () => {
    for (const locale of ['en-US', 'xx-ZZ']) {
      const { page, context, errors } = await popup(browser, { locale });
      try {
        if (locale === 'en-US') {
          assert.equal(await page.locator('#settingsView').isVisible(), true);
          await page.locator('#closeSettings').click();
          assert.equal(await page.locator('#targetLang').inputValue(), 'English');
        } else {
          assert.equal(await page.locator('#homeView').isVisible(), true);
          assert.equal(await page.locator('#targetLang').inputValue(), '');
        }
        assert.equal(await page.locator('#targetLang').isVisible(), true);
        assert.equal(await page.locator('#targetLang option').count(), 34);
        assert.equal(await page.locator('#sourceLanguage').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });

  await t.test('英文主界面和设置完整渲染，中文配置值不被界面翻译改写', async () => {
    const { page, context, errors } = await popup(browser, { saved: {
      schemaVersion: 13, targetLang: 'English', apiKey: 'sk-fixture', model: 'private-model', rulesText: '领域: 中文用户数据'
    } });
    try {
      const output = resolve(root, '.test-artifacts');
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: resolve(output, 'v0.17.5-home-en.png') });
      await page.locator('#openSettings').click();
      await page.screenshot({ path: resolve(output, 'v0.17.5-settings-en.png') });
      for (const panel of ['model', 'style', 'rules', 'tools']) {
        await page.locator(`[data-tab="${panel}"]`).click();
        const text = await page.locator(`[data-panel="${panel}"]`).innerText();
        assert.doesNotMatch(text, /\p{Script=Han}/u, panel);
      }
      assert.equal(await page.locator('#rulesText').inputValue(), '领域: 中文用户数据');
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => window.__requests.some(type => ['preflight', 'translate-chunk'].includes(type))), false);
    } finally { await context.close(); }
  });
  await t.test('测试按钮在当前视图即时反馈，状态变化不改变按钮尺寸', async () => {
    for (const language of ['English', '简体中文']) {
      const { page, context, errors } = await popup(browser, { saved: {
        schemaVersion: 13, targetLang: language, apiKey: 'fixture', model: 'fixture-model'
      } });
      try {
        await page.locator('#openSettings').click();
        await page.locator('#test').scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          const send = chrome.runtime.sendMessage;
          window.__testCalls = 0;
          chrome.runtime.sendMessage = message => message.type === 'test-connection'
            ? (window.__testCalls++, new Promise(resolve => { window.__finishTest = resolve; })) : send(message);
        });
        const button = page.locator('#test');
        const before = await button.boundingBox();
        await button.click();
        await button.dispatchEvent('click');
        assert.equal(await button.getAttribute('aria-busy'), 'true');
        assert.equal(await page.evaluate(() => window.__testCalls), 1);
        const after = await button.boundingBox();
        assert.equal(after.width, before.width);
        assert.equal(after.height, before.height);
        const notice = await page.locator('#actionToast').boundingBox();
        assert.ok(notice.y >= 0 && notice.y + notice.height <= 600);
        assert.equal(await page.locator('#homeView').isVisible(), false);
        assert.match(await page.locator('#actionNotice').textContent(), language === 'English' ? /Testing/ : /测试/);
        const output = resolve(root, '.test-artifacts');
        await mkdir(output, { recursive: true });
        await page.locator('#actionToast').evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
        await page.screenshot({ path: resolve(output, `v0.17.7-feedback-${language === 'English' ? 'en' : 'zh'}.png`) });
        await page.evaluate(() => window.__finishTest({ ok: false, error: { message: 'Fixture: connection failed' } }));
        await page.waitForFunction(() => document.querySelector('#test').dataset.feedback === 'error');
        assert.equal(await button.isEnabled(), true);
        assert.match(await page.locator('#actionNotice').textContent(), /Fixture: connection failed/);
        assert.equal((await button.boundingBox()).width, before.width);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await button.click();
        const animation = await button.evaluate(el => getComputedStyle(el, '::before').animationName);
        assert.equal(animation, 'none');
        await page.evaluate(() => window.__finishTest({ ok: true, echoed: 'ok' }));
        await page.waitForFunction(() => document.querySelector('#test').dataset.feedback === 'success');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });

  await t.test('工具页清理反馈不占窗口高度，计数独立，所有操作直接可达', async () => {
    const { page, context, errors } = await popup(browser, { saved: {
      schemaVersion: 13, targetLang: '简体中文', apiKey: 'fixture', model: 'fixture-model'
    } });
    try {
      await page.locator('#openSettings').click();
      await page.locator('[data-tab="tools"]').click();
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage;
        document.querySelector('#cacheCount').textContent = '143';
        window.__cacheCounter = document.querySelector('#cacheCount');
        chrome.runtime.sendMessage = msg => msg.type === 'clear-cache'
          ? new Promise(resolve => { window.__finishClear = resolve; }) : send(msg);
      });
      await page.locator('#clearCache').scrollIntoViewIfNeeded();
      const before = await page.locator('.popup-scroll').boundingBox();
      await page.locator('#clearCache').click();
      assert.deepEqual(await page.locator('.popup-scroll').boundingBox(), before);
      assert.equal(await page.locator('#clearCache #cacheCount').count(), 0);
      assert.equal(await page.locator('.maintenance-group').count(), 3);
      assert.equal(await page.locator('.maintenance-details').getAttribute('open'), null);
      assert.equal(await page.evaluate(() => document.querySelector('#cacheCount') === window.__cacheCounter), true);
      await page.evaluate(() => window.__finishClear({ ok: true, cache: { entries: 0 } }));
      await page.waitForFunction(() => document.querySelector('#clearCache').dataset.feedback === 'success');
      assert.equal(await page.locator('#cacheCount').textContent(), '0');
      assert.equal(await page.evaluate(() => document.querySelector('#cacheCount') === window.__cacheCounter), true);
      await page.locator('#clearAcceptance').scrollIntoViewIfNeeded();
      const last = await page.locator('#clearAcceptance').boundingBox();
      assert.ok(last.y + last.height <= 600);
      await page.locator('#dismissNotice').click();
      await page.locator('.maintenance-block').evaluate(el => {
        document.querySelector('.popup-scroll').scrollTop += el.getBoundingClientRect().top - 14;
      });
      await page.screenshot({ path: resolve(root, '.test-artifacts/v0.17.7-tools.png') });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('保存提示自动收起且不挤压内容，长错误可读可关闭，Markdown 可实际下载', async () => {
    const { page, context, errors } = await popup(browser, { saved: {
      schemaVersion: 13, targetLang: '简体中文', apiKey: 'fixture', model: 'fixture-model'
    } });
    try {
      const before = await page.locator('.popup-scroll').boundingBox();
      await page.locator('[data-mode="translation"]').click();
      await page.waitForFunction(() => document.querySelector('#actionNotice').textContent === '设置已保存');
      assert.deepEqual(await page.locator('.popup-scroll').boundingBox(), before);
      await page.locator('#actionToast').evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
      await page.screenshot({ path: resolve(root, '.test-artifacts/v0.17.7-home-feedback.png') });
      await page.waitForFunction(() => document.querySelector('#actionToast').hidden);
      assert.deepEqual(await page.locator('.popup-scroll').boundingBox(), before);
      await page.screenshot({ path: resolve(root, '.test-artifacts/v0.17.7-home.png') });

      await page.locator('#openSettings').click();
      await page.locator('[data-tab="tools"]').click();
      await page.evaluate(() => {
        chrome.tabs.sendMessage = async () => ({ ok: false, error: { message: '长错误：' + '无法读取页面状态；请刷新后重试。'.repeat(40) } });
      });
      await page.locator('#exportMd').click();
      await page.waitForFunction(() => document.querySelector('#actionNotice').dataset.tone === 'error');
      const longNotice = await page.locator('#actionNotice').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
      assert.ok(longNotice.height <= 156 && longNotice.scroll > longNotice.height);
      assert.equal(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth), true);
      await page.locator('#dismissNotice').click();
      assert.equal(await page.locator('#actionToast').isVisible(), false);

      const markdown = '## A heading\n\n**一个标题**\n\n| A | B |\n| --- | --- |\n| 原文 | 译文 |\n';
      await page.evaluate(markdown => { chrome.tabs.sendMessage = async () => ({ ok: true, markdown }); }, markdown);
      const download = page.waitForEvent('download');
      await page.locator('#exportMd').click();
      const file = await download;
      assert.equal(file.suggestedFilename(), 'example.test-bilingual.md');
      assert.equal(await readFile(await file.path(), 'utf8'), markdown);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

});
