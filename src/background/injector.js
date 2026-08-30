import { MSG } from '../shared/constants.js';
import { log } from '../shared/logger.js';

const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

export function isInjectable(url) {
  if (!url) return false;
  if (RESTRICTED.test(url)) return false;
  if (url.startsWith('https://chromewebstore.google.com')) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

export async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/**
 * manifest 已负责普通网页的静态注入；这里仅是当前页兜底。
 * 典型场景是扩展刚更新、旧标签页尚未导航，或用户把站点访问限制为“点击时”。
 * popup/action 带来的 activeTab 授权让这条兜底仍然可用。
 */
export async function ensureContent(tabId) {
  if (await pingTab(tabId)) return true;

  await chrome.scripting.insertCSS({ target: { tabId }, files: ['assets/content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/loader.js'] });

  // loader 用动态 import 拉起 ES module，需要等它就绪
  for (let i = 0; i < 40; i++) {
    if (await pingTab(tabId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  log('content script 注入后未响应', tabId);
  return false;
}
