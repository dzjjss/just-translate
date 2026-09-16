import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionFeedback, waitForReply } from '../src/shared/action-feedback.js';
import { translateUi } from '../src/shared/ui-language.js';
import * as hud from '../src/content/hud.js';
import * as fab from '../src/content/float-widget.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.test' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.chrome = { runtime: { getManifest: () => ({ version: 'fixture' }) } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = () => document.body.appendChild(document.createElement('button'));
let cases = 0;
async function test(name, task) { await task(); cases++; console.log('  ✓', name); }

await test('同步调用保留用户手势，按钮子节点和计数不被反馈重建', async () => {
  const b = button(); b.innerHTML = '清理 <em>143</em>';
  const counter = b.firstElementChild;
  let invoked = false, release;
  const feedback = createActionFeedback();
  const running = feedback.run(b, () => { invoked = true; return new Promise(resolve => { release = resolve; }); });
  assert.equal(invoked, true);
  assert.equal(b.disabled, true);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.equal(b.firstElementChild, counter);
  release({ ok: true }); await running;
  assert.equal(b.firstElementChild, counter);
  assert.equal(b.textContent, '清理 143');
  assert.equal(b.dataset.feedback, 'success');
});

await test('同组操作跨按钮互斥，拒绝后释放锁并允许重试', async () => {
  const a = button(), b = button();
  let reject, duplicate = 0;
  const f = createActionFeedback();
  const pending = f.run(a, () => new Promise((_, r) => { reject = r; }), { group: 'fixture-clear' });
  await f.run(b, () => duplicate++, { group: 'fixture-clear' });
  assert.equal(duplicate, 0);
  reject(Error('denied')); await pending;
  await f.run(b, () => duplicate++, { group: 'fixture-clear' });
  assert.equal(duplicate, 1);
  assert.equal(a.disabled, false);
});

await test('按钮完成后重新计算业务禁用状态，不能把未修改的应用按钮启用', async () => {
  const b = button();
  await createActionFeedback().run(b, () => ({ ok: true }), { onSettled: () => { b.disabled = true; } });
  assert.equal(b.disabled, true);
});

await test('超时后迟到响应不再进入调用方的成功分支', async () => {
  let release, committed = false;
  const pending = waitForReply(new Promise(resolve => { release = resolve; }), 1).then(() => { committed = true; });
  await assert.rejects(pending, /超时/);
  release('late'); await tick();
  assert.equal(committed, false);
});

await test('较早的自动保存回执不能盖掉后来按钮的结果', async () => {
  let message;
  const f = createActionFeedback({ announce: text => { message = text; } });
  const oldSave = f.beginNotice('saving');
  await f.run(button(), () => ({ ok: false, message: 'test failed' }));
  oldSave('saved');
  assert.equal(message, 'test failed');
});

await test('状态条异步按钮立即反馈，后台拒绝后可重试', async () => {
  let release, count = 0;
  hud.mount({ toggle: () => (count++, new Promise(resolve => { release = resolve; })) });
  const root = document.querySelector('#byom-hud').shadowRoot;
  const b = root.querySelector('[data-act="toggle"]');
  b.click(); b.click();
  assert.equal(b.dataset.feedback, 'busy');
  assert.equal(count, 1);
  release({ ok: false, message: '保存失败' }); await tick();
  assert.equal(b.dataset.feedback, 'error');
  assert.equal(b.disabled, false);
  assert.match(root.querySelector('[role="status"]').textContent, /保存失败/);
  hud.unmount();
});

await test('悬浮球重建后按钮仍反馈，失败不是未处理的 Promise', async () => {
  let reject, count = 0;
  const handlers = { translate: () => (count++, new Promise((_, r) => { reject = r; })), state: () => ({ phase: 'idle' }) };
  fab.sync({ floatButton: true, targetLang: 'English' }, handlers);
  let root = document.querySelector('#byom-fab').shadowRoot;
  root.querySelector('.btn').click(); root.querySelector('.btn').click();
  assert.equal(count, 1);
  assert.equal(root.querySelector('.btn').dataset.feedbackLabel, 'Working…');
  reject(Error('fixture failure')); await tick();
  assert.equal(root.querySelector('.btn').disabled, false);
  assert.match(root.querySelector('[role="status"]').textContent, /fixture failure/);
  fab.sync({ floatButton: false });
  fab.sync({ floatButton: true }, { translate: () => ({ ok: true }), state: () => ({ phase: 'idle' }) });
  root = document.querySelector('#byom-fab').shadowRoot;
  root.querySelector('.btn').click(); await tick();
  assert.equal(root.querySelector('.btn').dataset.feedbackLabel, 'Done');
  fab.sync({ floatButton: false });
});

await test('统一反馈消息在中英文界面都可读', async () => {
  const b = button(); let message;
  const f = createActionFeedback({ translate: text => translateUi('English', text), announce: text => { message = text; } });
  await f.run(b, () => ({ ok: false, message: '没有该域名的访问权限' }));
  assert.equal(b.dataset.feedbackLabel, 'Not completed');
  assert.doesNotMatch(message, /\p{Script=Han}/u);
});

console.log(`${cases} 个用例全部通过（共享反馈与页面按钮）`);
