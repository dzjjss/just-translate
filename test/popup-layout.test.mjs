/**
 * 真实 Chromium 排版回归；不模拟扩展宿主的原生自动定窗。
 * 加载发布用 HTML/CSS，以确定性的 DOM 更新覆盖动态内容尺寸。
 * 不执行 popup.js、不连接翻译服务；事件接线由 popup.test.mjs 覆盖。
 * npm exec playwright-core install chromium && npm run test:layout
 * 也可用 JT_CHROMIUM_PATH 指定已有 Chromium，JT_LAYOUT_ROOT 指定旧包作对照。
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = process.env.JT_LAYOUT_ROOT || fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(resolve(root, 'src/popup/popup.html'), 'utf8');
const css = await readFile(resolve(root, 'src/popup/popup.css'), 'utf8');
const icon = await readFile(resolve(root, 'assets/icon32.png'));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const fixture = html
  .replace('<link rel="stylesheet" href="popup.css" />', `<style>${css}</style>`)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace('../../assets/icon32.png', `data:image/png;base64,${icon.toString('base64')}`)
  .replace('>v–</span>', `>v${manifest.version}</span>`);

async function openPanel(page, panel) {
  await page.evaluate(panel => {
    document.getElementById('homeView').hidden = panel !== 'home';
    document.getElementById('settingsView').hidden = panel === 'home';
    for (const el of document.querySelectorAll('[data-panel]')) el.hidden = el.dataset.panel !== panel;
    for (const el of document.querySelectorAll('[data-tab]')) el.dataset.active = el.dataset.tab === panel ? '1' : '0';
    document.querySelector('.popup-scroll')?.scrollTo(0, 0);
  }, panel);
}

async function loadPopup(page) {
  await page.setContent(fixture);
  await page.evaluate(() => {
    document.getElementById('pair').textContent = '自动识别 → 简体中文';
    document.getElementById('peekModel').textContent = 'DeepSeek 官方 · 省钱档 · deepseek-v4-flash · 待配置';
    const option = document.createElement('option');
    option.textContent = 'DeepSeek 官方 · 省钱档';
    option.value = 'deepseek';
    document.getElementById('providerId').add(option);
    document.getElementById('apiBase').value = 'https://api.deepseek.com';
    document.getElementById('model').value = 'deepseek-v4-flash';
  });
  await openPanel(page, 'model');
}

async function measure(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.popup-scroll');
    const back = document.getElementById('closeSettings')?.getBoundingClientRect();
    const gear = document.getElementById('openSettings').getBoundingClientRect();
    return {
      rootWidth: document.documentElement.getBoundingClientRect().width,
      bodyWidth: document.body.getBoundingClientRect().width,
      bodyHeight: document.body.getBoundingClientRect().height,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      pageScrollY: window.scrollY,
      innerWidth: scroll?.clientWidth,
      innerOverflow: scroll ? scroll.scrollHeight > scroll.clientHeight : null,
      backHeight: back?.height,
      gearWidth: gear.width,
      gearHeight: gear.height,
    };
  });
}

test('弹窗在 Chromium 中保持尺寸与滚动可达性', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({
    executablePath: process.env.JT_CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--disable-gpu'],
  });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()}；原生扩展宿主仍需手动验收`);

  await t.test('较窄的初始视口不能使弹窗跟随收缩', async () => {
    const page = await browser.newPage();
    try {
      await loadPopup(page);
      for (const width of [420, 340, 280, 800, 420]) {
        await page.setViewportSize({ width, height: 600 });
        const box = await measure(page);
        assert.equal(box.bodyWidth, 420, `初始视口 ${width}px 时正文宽度改变`);
        assert.equal(box.rootWidth, 420, `初始视口 ${width}px 时根节点宽度改变`);
        assert.equal(box.gearWidth, 36, '齿轮被 flex 挤压');
        assert.equal(box.gearHeight, 36);
        assert.ok(box.backHeight <= 30, '返回按钮被挤成两行');
        assert.equal(box.bodyOverflow, 0, '内容把根节点撑宽');
      }
    } finally { await page.close(); }
  });

  await t.test('反复跨过 600px 高度边界，滚动条不改变内容宽度', async () => {
    const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
    try {
      await loadPopup(page);
      assert.equal(await page.locator('.popup-scroll').count(), 1, '缺少独立的内部滚动区');
      const initial = await measure(page);
      for (const height of [599, 600, 601, 600, 599, 601, 900, 220]) {
        await page.evaluate(height => {
          const main = document.querySelector('main');
          main.replaceChildren();
          main.style.height = `${height - document.querySelector('header').getBoundingClientRect().height - 14}px`;
        }, height);
        const box = await measure(page);
        assert.equal(box.bodyWidth, 420);
        assert.equal(box.innerWidth, initial.innerWidth, `内容高度 ${height}px 导致滚动区宽度变化`);
        assert.ok(Math.abs(box.bodyHeight - Math.min(height, 600)) < 1, '外框高度未按内容收敛');
        assert.equal(box.innerOverflow, height > 600, '滚动条临界高度不正确');
        assert.equal(box.pageScrollY, 0, '根页面承担了滚动');
      }
    } finally { await page.close(); }
  });

  await t.test('首页及四个设置页在不同像素密度下保持宽度，底部控件可达', async () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const page = await browser.newPage({ viewport: { width: 420, height: 600 }, deviceScaleFactor: scale });
      try {
        await loadPopup(page);
        for (const panel of ['home', 'model', 'style', 'rules', 'tools', 'model']) {
          await openPanel(page, panel);
          const box = await measure(page);
          assert.equal(box.bodyWidth, 420, `${panel} / ${scale}x 宽度漂移`);
          assert.ok(box.bodyHeight <= 600);
          assert.equal(box.bodyOverflow, 0);
        }
        if (scale === 1 && process.env.JT_LAYOUT_SCREENSHOTS) {
          const output = process.env.JT_LAYOUT_SCREENSHOTS;
          await mkdir(output, { recursive: true });
          await page.screenshot({ path: resolve(output, 'popup-engine.png') });
        }
        await openPanel(page, 'tools');
        const bottom = page.locator('#clearAcceptance');
        await bottom.scrollIntoViewIfNeeded();
        const rect = await bottom.boundingBox();
        assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 600, '底部控件被裁掉');
        assert.ok(await page.locator('.popup-scroll').evaluate(el => el.scrollTop > 0));
        assert.equal((await measure(page)).pageScrollY, 0, '滚动泄漏到宿主根页面');
      } finally { await page.close(); }
    }
  });
});
