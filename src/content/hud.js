import { createActionFeedback } from '../shared/action-feedback.js';
import { PRESET_REASON } from '../shared/constants.js';
import { createHost, destroyHost } from './ui-host.js';
import { HUD_CSS } from './ui-css.js';
import { translateUi } from '../shared/ui-language.js';

/**
 * 页面右下角的状态条。同样住在 Shadow DOM 里。
 * 除了进度，它还负责把自动识别的结果和依据摆出来，并允许当场改 ——
 * 自动识别一定会有认错的时候，看得见才纠正得了。
 */

const HOST_ID = 'byom-hud';
const feedback = createActionFeedback({ translate: text => t(text), announce: (message, tone) => {
  const notice = entry?.root.querySelector('.jt-action-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.tone = tone;
} });

/** 版本号取自 manifest，和面板同源。 */
function versionLabel() {
  const v = chrome.runtime?.getManifest?.()?.version;
  return v ? 'v' + v : '';
}

let entry = null;
let handlers = {};
const defaultUi = (...args) => translateUi('简体中文', ...args);
const t = (...args) => (handlers.translateUi || defaultUi)(...args);

export function mount(h = {}) {
  handlers = h;
  if (entry?.host.isConnected) return;

  const options = (h.presetOptions || [])
    .map((p) => `<option value="${p.id}">${t(p.label)}</option>`)
    .join('');

  entry = createHost(HOST_ID, HUD_CSS);
  entry.root.innerHTML += `
    <div class="panel">
      <div class="row">
        <span class="dot"></span>
        <span class="text">${t('准备中')}</span>
        <span class="ver">${versionLabel()}</span>
      </div>
      <div class="track"><i></i></div>
      <div class="row ctx">
        <select class="preset" data-act="preset" title="${t('改语境，对后续段落立即生效')}">${options}</select>
        <span class="reason"></span>
      </div>
      <div class="row actions">
        <button type="button" data-act="toggle">${t('双语')}</button>
        <button type="button" data-act="stop">${t('停止')}</button>
        <button type="button" data-act="bypass">${t('重翻⟳')}</button>
        <button type="button" data-act="clear">${t('清除')}</button>
        <button type="button" data-act="close">×</button>
      </div>
      <div class="jt-action-notice" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;

  entry.root.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (!act || act === 'preset') return;
    e.preventDefault();
    e.stopPropagation();
    if (act === 'close') return unmount();
    const options = {
      toggle: { pending: '切换中…', success: '已切换', group: 'display' },
      stop: { pending: '处理中…', success: '已完成', group: 'page-start' },
      bypass: { pending: '启动中…', success: '已启动', group: 'page-start' },
      clear: { pending: '清理中…', success: '已清除', group: 'page-clear' }
    };
    void feedback.run(e.target, () => handlers[act]?.(), options[act]);
  });

  entry.root.querySelector('[data-act="preset"]').addEventListener('change', (e) => {
    e.stopPropagation();
    handlers.preset?.(e.target.value);
    feedback.notice('语境已切换，对后续段落生效');
  });
}

export function update({
  text,
  done = 0,
  total = 0,
  failed = 0,
  phase = 'idle',
  displayMode = 'bilingual',
  presetId,
  presetReason
}) {
  if (!entry?.host.isConnected) return;
  const root = entry.root;
  localizeControls(root);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  root.querySelector('.text').textContent =
    text || (total ? `${done} / ${total}${failed ? t` · ${failed} 失败` : ''}` : t('没有可翻译的内容'));
  root.querySelector('.track i').style.width = pct + '%';
  entry.host.dataset.phase = phase;

  updateContext(root, presetId, presetReason);

  const toggle = root.querySelector('[data-act="toggle"]');
  if (toggle) {
    toggle.textContent = { bilingual: t('双语'), translation: t('仅译文'), original: t('仅原文') }[displayMode] || t('双语');
  }
  const busy = phase === 'translating' || phase === 'scanning';
  const stop = root.querySelector('[data-act="stop"]');
  if (stop) stop.textContent = busy ? t('停止') : t('重翻');
  const bypass = root.querySelector('[data-act="bypass"]');
  if (bypass) bypass.hidden = busy;
}

function localizeControls(root) {
  for (const [act, title] of Object.entries({ toggle: t('双语 / 仅译文 / 仅原文'),
    bypass: t('清除后重翻整页，且这一轮不走缓存'), clear: t('移除所有译文，页面回到原样'), close: t('关闭状态条'),
    preset: t('改语境，对后续段落立即生效') })) root.querySelector(`[data-act="${act}"]`).title = t(title);
  root.querySelector('[data-act="clear"]').textContent = t('清除');
  root.querySelector('[data-act="bypass"]').textContent = t('重翻⟳');
  for (const item of handlers.presetOptions || []) {
    const option = [...root.querySelector('.preset').options].find(option => option.value === item.id);
    if (option) option.textContent = t(item.label);
  }
}

function updateContext(root, presetId, presetReason) {
  const select = root.querySelector('.preset');
  if (presetId && select && select.value !== presetId && root.activeElement !== select) {
    select.value = presetId;
  }
  const reason = root.querySelector('.reason');
  if (reason && presetReason) {
    reason.textContent = t(PRESET_REASON[presetReason] || presetReason);
    // 没认出来就是没认出来，标出来让人去指定
    reason.dataset.weak = presetReason === 'fallback' ? '1' : '0';
  }

}

export function unmount() {
  destroyHost(HOST_ID);
  entry = null;
}

export function isMounted() {
  return Boolean(entry?.host.isConnected);
}
