import { MSG } from '../shared/constants.js';
import { getSettings, isConfigured, toRuntimeConfig } from '../shared/settings.js';
import { hasApiPermission } from '../shared/permissions.js';
import { toPlainError, log } from '../shared/logger.js';
import { ensureContent, isInjectable, pingTab } from './injector.js';
import { abortSession, convertRules, fetchModels, runPreflight, testConnection, translateChunk } from './translator.js';
import { cacheStats, clearCache, flush } from './cache.js';
import { getProvider } from './providers/index.js';

/** 页面上双击译文时留下的原文，供面板的试译台取材 */
let labSample = '';

/**
 * 取目标标签页。
 * 内容脚本发来的消息一律用 sender.tab.id —— 它自己就在那一页上，
 * 回落到"当前活动标签页"会翻错页：在后台标签页打开一个命中自动翻译规则的链接时，
 * 扩展会去翻用户正在看的那一页。中键连开一串链接就能稳定触发。
 * 只有面板（sender.tab 为空）才允许指定 tabId 或回落到活动页。
 */
async function getTab(tabId, sender) {
  if (sender?.tab?.id) return sender.tab;
  if (tabId) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}


function settingsWithPanelOverride(base, override = {}, extra = {}) {
  const allowed = ['providerId', 'apiBase', 'apiKey', 'model'];
  const picked = {};
  for (const key of allowed) {
    if (override && Object.prototype.hasOwnProperty.call(override, key)) picked[key] = override[key];
  }
  if (Object.prototype.hasOwnProperty.call(extra, 'customPrompt')) picked.customPrompt = extra.customPrompt;
  return { ...base, ...picked };
}

async function preflight(tab) {
  const settings = await getSettings();
  if (!isConfigured(settings, getProvider(settings.providerId))) {
    return { ok: false, code: 'not-configured', error: { message: '先填写 API 地址、Key 和模型' } };
  }
  if (!(await hasApiPermission(settings.apiBase))) {
    return { ok: false, code: 'no-permission', error: { message: '还没授权访问该 API 域名' } };
  }
  if (!tab || !isInjectable(tab.url)) {
    return { ok: false, code: 'not-injectable', error: { message: '这个页面不允许注入脚本' } };
  }
  return { ok: true, settings };
}

/** 每个 tab 的 session 独立编号，取消一个不会影响另一个正在翻译的页面 */
function sessionKey(sender, sessionId) {
  return `${sender?.tab?.id ?? 0}:${sessionId}`;
}

export const handlers = {
  async [MSG.QUERY_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    const settings = await getSettings();
    const injectable = isInjectable(tab?.url);
    const injected = injectable && tab ? await pingTab(tab.id) : false;
    let state = null;
    if (injected) {
      state = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATE }).catch(() => null);
    }
    return {
      ok: true,
      tabId: tab?.id ?? null,
      url: tab?.url ?? '',
      injectable,
      injected,
      state,
      configured: isConfigured(settings, getProvider(settings.providerId)),
      hasPermission: await hasApiPermission(settings.apiBase),
      cache: cacheStats(),
      labSample
    };
  },

  async [MSG.SET_LAB_SAMPLE]({ text }) {
    labSample = String(text || '').slice(0, 1200);
    return { ok: true };
  },

  /**
   * 试译：必须走 translateChunk 这条正式路径，只是把 items 换成调试框里那一段。
   * 另起一套 prompt 会让"调试框里试通了、整页翻出来不一样"，那样这个工具就是负资产。
   */
  async [MSG.LAB_TRANSLATE](payload) {
    const baseSettings = await getSettings();
    const settings = settingsWithPanelOverride(baseSettings, payload.settingsOverride, { customPrompt: payload.customPrompt });
    const provider = getProvider(settings.providerId);
    if (!isConfigured(settings, provider)) return { ok: false, error: { message: '先配置好模型' } };
    if (!(await hasApiPermission(settings.apiBase))) {
      return { ok: false, code: 'no-permission', error: { message: '还没授权访问该 API 域名' } };
    }
    const text = String(payload.text || '').trim();
    if (!text) return { ok: false, error: { message: '先填一段原文' } };

    try {
      const res = await translateChunk({
        items: [{ i: 1, text }],
        context: {
          title: payload.context?.title || '',
          hostname: payload.context?.hostname || '',
          presetId: payload.presetId || settings.presetId,
          background: payload.background ?? settings.background,
          profile: payload.profile || null
        },
        settings,
        sessionId: 'lab',
        bypassCache: true // 调试永远要看模型这次实际怎么翻，不能给缓存
      });
      const hit = (res.items || []).find((x) => x.i === 1);
      if (!hit) return { ok: false, error: { message: '模型没有返回这一段' } };
      return { ok: true, text: hit.t, usage: res.usage };
    } catch (e) {
      return { ok: false, error: toPlainError(e) };
    }
  },

  async [MSG.START_ON_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    const pre = await preflight(tab);
    if (!pre.ok) return pre;

    const ready = await ensureContent(tab.id);
    if (!ready) {
      return { ok: false, code: 'inject-failed', error: { message: '注入失败，刷新页面后重试' } };
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.START,
      payload: { config: toRuntimeConfig(pre.settings) }
    });
    return { ok: true, tabId: tab.id };
  },

  async [MSG.STOP_ON_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    if (!tab) return { ok: false };
    await chrome.tabs.sendMessage(tab.id, { type: MSG.STOP }).catch(() => {});
    return { ok: true };
  },

  async [MSG.TOGGLE_ON_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    if (!tab || !(await pingTab(tab.id))) return { ok: false };
    const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_VISIBILITY });
    return { ok: true, visible: res?.visible };
  },

  async [MSG.TRANSLATE_CHUNK](payload, sender) {
    const settings = await getSettings();
    try {
      const res = await translateChunk({
        items: payload.items,
        context: payload.context || {},
        bypassCache: Boolean(payload.bypassCache),
        settings,
        sessionId: sessionKey(sender, payload.sessionId)
      });
      return { ok: true, ...res };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, code: 'aborted', error: { message: '已取消' } };
      return { ok: false, code: 'api-error', error: toPlainError(e) };
    }
  },

  async [MSG.ABORT_SESSION](payload, sender) {
    const stopped = abortSession(sessionKey(sender, payload.sessionId));
    await flush();
    log('中止 session', stopped);
    return { ok: true, stopped };
  },

  /**
   * 预检的独立入口：只注入、只预检，不启动翻译。
   * 之前预检的消息通道依赖 content script 已存在，而注入又只挂在"开始翻译"上，
   * 等于必须先翻一次才能预检——本末倒置。这条路径修正它。
   */

  async [MSG.PREFLIGHT_ON_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    const pre = await preflight(tab);
    if (!pre.ok) return pre;
    const ready = await ensureContent(tab.id);
    if (!ready) {
      return { ok: false, code: 'inject-failed', error: { message: '注入失败，刷新页面后重试' } };
    }
    // 先把运行时配置发下去，content 侧扫描需要它（不启动翻译）
    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.CONFIG_CHANGED,
      payload: { config: toRuntimeConfig(pre.settings) }
    });
    return chrome.tabs.sendMessage(tab.id, { type: MSG.RUN_PREFLIGHT });
  },

  /**
   * 内容脚本自举用。manifest 静态拉起 loader 后没有人主动推配置，
   * 所以页面自己取一次 RuntimeConfig；这里绝不返回 Key / endpoint 等私有字段。
   */
  /** 悬浮球被拖动后记住位置。content 无权写 storage，只能走这里 */
  async [MSG.SAVE_FAB_OFFSET]({ offset }) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, floatOffset: Math.round(n) } });
    return { ok: true };
  },

  /** 页面上切换显示模式后写回设置，下一页打开保持同一偏好 */
  async [MSG.SAVE_DISPLAY_MODE]({ mode }) {
    if (!['bilingual', 'translation', 'original'].includes(mode)) return { ok: false };
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, displayMode: mode } });
    return { ok: true };
  },

  async [MSG.GET_CONFIG]() {
    const settings = await getSettings();
    return { ok: true, config: toRuntimeConfig(settings) };
  },

  async [MSG.SYNC_ON_TAB]({ tabId }, sender) {
    const tab = await getTab(tabId, sender);
    if (!tab || !isInjectable(tab.url)) {
      return { ok: false, code: 'not-injectable', error: { message: '这个页面不允许注入脚本' } };
    }
    const settings = await getSettings();

    // 只在"页面已经注入过"或"用户要显示悬浮球"时才注入。
    // 单纯改个并发数就往页面里塞脚本和样式是没必要的副作用。
    const alreadyIn = await pingTab(tab.id);
    if (!alreadyIn && !settings.floatButton) return { ok: true, injected: false };

    const ready = await ensureContent(tab.id);
    if (!ready) return { ok: false, code: 'inject-failed', error: { message: '注入失败，刷新页面后重试' } };
    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.CONFIG_CHANGED,
      payload: { config: toRuntimeConfig(settings) }
    });
    return { ok: true, injected: true };
  },

  async [MSG.PREFLIGHT](payload, sender) {
    const settings = await getSettings();
    try {
      const res = await runPreflight({
        digest: payload.digest,
        context: payload.context || {},
        settings,
        sessionId: sessionKey(sender, payload.sessionId)
      });
      return { ok: true, ...res };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, code: 'aborted', error: { message: '已取消' } };
      return { ok: false, code: 'api-error', error: toPlainError(e) };
    }
  },

  // 翻译期间页面每 20 秒敲一次，把 service worker 的空闲计时器顶回去。
  // 页面关掉或翻译结束心跳就停，不会无意义地长期吊着 worker。
  async [MSG.HEARTBEAT]() {
    return { ok: true };
  },

  async [MSG.TEST_CONNECTION](payload) {
    const settings = settingsWithPanelOverride(await getSettings(), payload.settingsOverride);
    if (!isConfigured(settings, getProvider(settings.providerId))) return { ok: false, error: { message: '配置还不完整' } };
    if (!(await hasApiPermission(settings.apiBase))) {
      return { ok: false, code: 'no-permission', error: { message: '还没授权访问该 API 域名' } };
    }
    try {
      const res = await testConnection(settings);
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: toPlainError(e) };
    }
  },

  async [MSG.CONVERT_RULES](payload) {
    const settings = settingsWithPanelOverride(await getSettings(), payload.settingsOverride);
    if (!isConfigured(settings, getProvider(settings.providerId))) return { ok: false, error: { message: '先配置好模型' } };
    if (!(await hasApiPermission(settings.apiBase))) {
      return { ok: false, code: 'no-permission', error: { message: '还没授权访问该 API 域名' } };
    }
    try {
      return { ok: true, ...(await convertRules({ text: payload.text, context: payload.context || {}, settings })) };
    } catch (e) {
      return { ok: false, error: toPlainError(e) };
    }
  },

  async [MSG.LIST_MODELS](payload) {
    const settings = settingsWithPanelOverride(await getSettings(), payload.settingsOverride);
    if (!settings.apiBase) return { ok: false, error: { message: '先填 API 地址' } };
    if (!(await hasApiPermission(settings.apiBase))) {
      return { ok: false, code: 'no-permission', error: { message: '还没授权访问该 API 域名' } };
    }
    try {
      return await fetchModels(settings);
    } catch (e) {
      return { ok: false, error: toPlainError(e) };
    }
  },

  async [MSG.CLEAR_CACHE]() {
    await clearCache();
    return { ok: true, cache: cacheStats() };
  },

  async [MSG.CACHE_STATS]() {
    return { ok: true, cache: cacheStats() };
  },

  // content 广播状态给 popup，后台只负责应答避免 "no receiving end" 噪音
  async [MSG.TAB_STATE]() {
    return { ok: true };
  }
};

/**
 * 只有面板才能调的处理函数。
 *
 * 之前所有 handler 对内容脚本一视同仁：一个被攻破的内容脚本可以传任意 tabId
 * 去读别的标签页 URL、操纵别的页面，或者反复触发带 Key 的外呼来刷账单。
 * 我们花力气把 storage 收紧到可信上下文，却在消息层留了后门，逻辑上不自洽。
 *
 * 判据是 sender.tab：面板没有 tab，内容脚本一定有。
 */
const PANEL_ONLY = new Set([
  MSG.QUERY_TAB,
  MSG.STOP_ON_TAB,
  MSG.TOGGLE_ON_TAB,
  MSG.SYNC_ON_TAB,
  MSG.PREFLIGHT_ON_TAB,
  MSG.TEST_CONNECTION,
  MSG.LIST_MODELS,
  MSG.CONVERT_RULES,
  MSG.LAB_TRANSLATE,
  MSG.CLEAR_CACHE,
  MSG.CACHE_STATS,
]);

export function installRouter() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = handlers[msg?.type];
    if (!handler) return false;
    if (sender?.tab && PANEL_ONLY.has(msg.type)) {
      sendResponse({ ok: false, code: 'forbidden', error: { message: '该操作只能从扩展面板发起' } });
      return false;
    }
    Promise.resolve(handler(msg.payload || {}, sender))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: toPlainError(e) }));
    return true; // 异步应答
  });
}
