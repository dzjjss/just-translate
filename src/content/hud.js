import { PRESET_REASON } from '../shared/constants.js';
import { createHost, destroyHost } from './ui-host.js';
import { HUD_CSS } from './ui-css.js';

/**
 * 页面右下角的状态条。同样住在 Shadow DOM 里。
 * 除了进度，它还负责把自动识别的结果和依据摆出来，并允许当场改 ——
 * 自动识别一定会有认错的时候，看得见才纠正得了。
 */

const HOST_ID = 'byom-hud';

/** 版本号取自 manifest，和面板同源。 */
function versionLabel() {
  const v = chrome.runtime?.getManifest?.()?.version;
  return v ? 'v' + v : '';
}

let entry = null;
let handlers = {};

export function mount(h = {}) {
  handlers = h;
  if (entry?.host.isConnected) return;

  const options = (h.presetOptions || [])
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join('');

  entry = createHost(HOST_ID, HUD_CSS);
  entry.root.innerHTML += `
    <div class="panel">
      <div class="row">
        <span class="dot"></span>
        <span class="text">准备中</span>
        <span class="ver">${versionLabel()}</span>
      </div>
      <div class="track"><i></i></div>
      <div class="row ctx">
        <select class="preset" data-act="preset" title="改语境，对后续段落立即生效">${options}</select>
        <span class="reason"></span>
      </div>
      <div class="row actions">
        <button type="button" data-act="toggle" title="双语 / 仅译文 / 仅原文">双语</button>
        <button type="button" data-act="stop">停止</button>
        <button type="button" data-act="bypass" title="清除后重翻整页，且这一轮不走缓存">重翻⟳</button>
        <button type="button" data-act="clear" title="移除所有译文，页面回到原样">清除</button>
        <button type="button" data-act="close" title="关闭状态条">×</button>
      </div>
    </div>`;

  entry.root.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (!act || act === 'preset') return;
    e.preventDefault();
    e.stopPropagation();
    if (act === 'close') return unmount();
    handlers[act]?.();
  });

  entry.root.querySelector('[data-act="preset"]').addEventListener('change', (e) => {
    e.stopPropagation();
    handlers.preset?.(e.target.value);
  });
}

export function update({
  text,
  done = 0,
  total = 0,
  failed = 0,
  phase = 'idle',
  visible = true,
  displayMode = 'bilingual',
  presetId,
  presetReason
}) {
  if (!entry?.host.isConnected) return;
  const root = entry.root;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  root.querySelector('.text').textContent =
    text || (total ? `${done} / ${total}${failed ? ` · ${failed} 失败` : ''}` : '没有可翻译的内容');
  root.querySelector('.track i').style.width = pct + '%';
  entry.host.dataset.phase = phase;

  const select = root.querySelector('.preset');
  if (presetId && select && select.value !== presetId && root.activeElement !== select) {
    select.value = presetId;
  }
  const reason = root.querySelector('.reason');
  if (reason && presetReason) {
    reason.textContent = PRESET_REASON[presetReason] || presetReason;
    // 没认出来就是没认出来，标出来让人去指定
    reason.dataset.weak = presetReason === 'fallback' ? '1' : '0';
  }

  const toggle = root.querySelector('[data-act="toggle"]');
  if (toggle) {
    toggle.textContent = { bilingual: '双语', translation: '仅译文', original: '仅原文' }[displayMode] || '双语';
  }
  const busy = phase === 'translating' || phase === 'scanning';
  const stop = root.querySelector('[data-act="stop"]');
  if (stop) stop.textContent = busy ? '停止' : '重翻';
  const bypass = root.querySelector('[data-act="bypass"]');
  if (bypass) bypass.hidden = busy;
}

export function unmount() {
  destroyHost(HOST_ID);
  entry = null;
}

export function isMounted() {
  return Boolean(entry?.host.isConnected);
}
