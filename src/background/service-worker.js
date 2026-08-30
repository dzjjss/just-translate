import { MSG } from '../shared/constants.js';
import { getSettingsAndPersistMigration, onSettingsChanged, toRuntimeConfig } from '../shared/settings.js';
import { setDebug, log, warn } from '../shared/logger.js';
import { installRouter, handlers } from './router.js';
import { setConcurrency, abortTab } from './translator.js';
import { flush, initCache } from './cache.js';
import { pingTab } from './injector.js';

installRouter();

/**
 * storage.local 默认对 content script 开放，而 API Key 就存在里面。
 * 把访问级别收紧到可信上下文，"Key 不下页面"才是真的能力边界，而不只是代码约定。
 */
async function lockDownStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (e) {
    warn('无法收紧 storage 访问级别，当前浏览器可能不支持：', e?.message || e);
  }
}

async function boot() {
  await lockDownStorage();
  // 迁移结果必须落盘，否则每次读都重跑
  const s = await getSettingsAndPersistMigration();
  setDebug(s.debug);
  setConcurrency(s.concurrency);
  await initCache();
  log('service worker 就绪');
}
boot();

onSettingsChanged(async (s) => {
  setDebug(s.debug);
  setConcurrency(s.concurrency);
  // 把新的运行时配置推给所有已注入的页面，不需要用户刷新
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    if (!(await pingTab(tab.id))) continue;
    chrome.tabs
      .sendMessage(tab.id, { type: MSG.CONFIG_CHANGED, payload: { config: toRuntimeConfig(s) } })
      .catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'translate-page') {
    const state = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATE }).catch(() => null);
    if (state?.running) await handlers[MSG.STOP_ON_TAB]({ tabId: tab.id });
    else await handlers[MSG.START_ON_TAB]({ tabId: tab.id });
  } else if (command === 'toggle-translations') {
    await handlers[MSG.TOGGLE_ON_TAB]({ tabId: tab.id });
  }
});

// 页面关闭或导航离开：中止这个 tab 还在飞和还在排队的请求。
// BYO API 花的是用户自己的钱，关了页面还继续跑是不能接受的。
chrome.tabs.onRemoved.addListener((tabId) => {
  abortTab(tabId);
  flush();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') abortTab(tabId);
});
chrome.runtime.onSuspend?.addListener?.(() => flush());
