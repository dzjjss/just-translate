import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createPopupNotice } from '../src/popup/notice.js';

function setup(t) {
  const dom = new JSDOM('<button id="action">Action</button><div id="toast" hidden><div role="status"></div><button>Close</button></div>');
  globalThis.document = dom.window.document;
  const container = document.querySelector('#toast');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => dom.window.close());
  return { container, report: createPopupNotice(container), dom };
}

test('成功提示会自动收起，新错误不被旧提示的定时器关闭', t => {
  const { container, report } = setup(t);
  report('Saved', 'success');
  assert.equal(container.hidden, false);
  t.mock.timers.tick(2000);
  report('Failed to save. Retry.', 'error');
  t.mock.timers.tick(20000);
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /Failed to save/);
  report('Saved', 'success');
  t.mock.timers.tick(10001);
  assert.equal(container.hidden, true);
});

test('键盘可关闭错误提示并返回原控件，提示出现时不抢焦点', t => {
  const { container, report, dom } = setup(t);
  const action = document.querySelector('#action');
  action.focus();
  report('Permission denied', 'error');
  assert.equal(document.activeElement, action);
  container.querySelector('button').focus();
  container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(container.hidden, true);
  assert.equal(document.activeElement, action);
});

test('悬停暂停成功提示消失，移开后重新留出阅读时间', t => {
  const { container, report, dom } = setup(t);
  report('Export completed', 'success');
  container.dispatchEvent(new dom.window.Event('pointerenter'));
  t.mock.timers.tick(15000);
  assert.equal(container.hidden, false);
  container.dispatchEvent(new dom.window.Event('pointerleave'));
  t.mock.timers.tick(10001);
  assert.equal(container.hidden, true);
});
