import { FAB_CSS } from './ui-css.js';

/**
 * 悬浮球：挂载、宿主、拖动、菜单、状态、失败提示、自愈，全部在这一个文件里。
 *
 * 之前散在三处：fab.js 管交互、ui-host.js 管宿主与重挂、main.js 管"该不该显示"。
 * 于是出了两类只有组合起来才会犯的病：
 *  1. ui-host 的自动重挂只是把节点 append 回去，绕过了 mount —— 事件监听与节点状态
 *     可能对不上，表现为"球在但点不动"。
 *  2. syncFab 以前依赖跨生命周期共享的 config，而配置来自 START / CONFIG_CHANGED / bootstrap 三条路径，
 *     时序不一致时 config 还是 null，直接返回，球就不出现。
 *
 * 现在对外只有一个 sync(config, handlers)：幂等，随便调多少次都行，
 * 该不该显示由它自己判断。球出问题永远只看这一个文件。
 */

const HOST_ID = 'byom-fab';
const ICON =
  '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 8h10"/><path d="M6 16h8"/><circle cx="5" cy="16" r="1.25" fill="currentColor" stroke="none"/></svg>';

let host = null;
let root = null;
let shell = null;
let handlers = {};
let config = {};
let watchdog = null;
let outsideClick = null;
let pressTimer = null;
let flashTimer = null;
let drag = null;
let onFullscreen = null;

/* ------------------------------ 构建与自愈 ------------------------------ */

function isHealthy() {
  // 光看节点在不在不够：宿主页面可能把 shadow 里的内容清了，
  // 这时"球还在"但已经是空壳，必须整体重建而不是补一个 append
  return Boolean(host?.isConnected && shell?.isConnected && root?.querySelector('.btn'));
}

function build() {
  teardownNode();

  host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-byom-skip', ''); // 提取器靠它跳过我们自己的界面
  host.setAttribute('translate', 'no');

  root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // host 自己保持零尺寸、static，不参与 fixed 定位或层叠；真正的浮层由 shadow 内层承担。
  // 这样既保留挂在 documentElement 的抗 body transform 优势，也避免 host 自身成为定位/层叠变量。
  style.textContent = `:host{all:initial !important;display:block !important;width:0 !important;height:0 !important;position:static !important;overflow:visible !important;margin:0 !important;padding:0 !important;border:0 !important;pointer-events:none !important;}\n${FAB_CSS}`;
  root.appendChild(style);

  shell = document.createElement('div');
  shell.className = 'fab-shell';
  shell.innerHTML = `
    <button type="button" class="btn" title="翻译本页（长按更多，可上下拖动）">${ICON}</button>
    <div class="menu" hidden>
      <button type="button" data-act="translate">翻译本页</button>
      <button type="button" data-act="preflight">刷新页面语境</button>
      <button type="button" data-act="clear">清除译文</button>
    </div>
    <div class="tip" hidden></div>`;
  root.appendChild(shell);

  bindEvents();
  // 挂到 documentElement：body 上有 transform 会让 fixed 失效，
  // 单页应用清空 body 也会把我们一起扫掉
  (document.fullscreenElement || document.documentElement).appendChild(host);
  applyPosition();
  syncPhase();
}

function bindEvents() {
  const btn = root.querySelector('.btn');
  const menu = root.querySelector('.menu');
  const openMenu = (open) => {
    menu.hidden = !open;
  };

  btn.addEventListener('click', () => {
    if (drag?.moved) return; // 拖完不要顺手触发翻译
    if (!menu.hidden) return openMenu(false);
    handlers.translate?.();
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(menu.hidden);
  });
  btn.addEventListener('pointerdown', (e) => {
    drag = { startY: e.clientY, baseTop: shell.getBoundingClientRect().top, moved: false };
    btn.setPointerCapture?.(e.pointerId);
    pressTimer = setTimeout(() => {
      if (!drag?.moved) openMenu(true);
    }, 450);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    clearTimeout(pressTimer);
    host.dataset.dragging = '1';
    shell.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, drag.baseTop + dy))}px`;
    shell.style.bottom = 'auto';
  });
  const endDrag = () => {
    clearTimeout(pressTimer);
    delete host.dataset.dragging;
    if (drag?.moved) {
      handlers.moved?.(Math.round((shell.getBoundingClientRect().top / window.innerHeight) * 100));
    }
    setTimeout(() => {
      drag = null;
    }, 0);
  };
  btn.addEventListener('pointerup', endDrag);
  btn.addEventListener('pointercancel', endDrag);

  menu.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    openMenu(false);
    handlers[act]?.();
  });

  outsideClick = (e) => {
    if (!host?.isConnected) return;
    // shadow 内的点击在 document 上看到的 target 是宿主，得用 composedPath
    if (e.composedPath?.().includes(host)) return;
    menu.hidden = true;
  };
  document.addEventListener('click', outsideClick, true);
}

function teardownNode() {
  if (outsideClick) {
    document.removeEventListener('click', outsideClick, true);
    outsideClick = null;
  }
  clearTimeout(pressTimer);
  clearTimeout(flashTimer);
  host?.remove();
  host = null;
  root = null;
  shell = null;
  drag = null;
}

/** 看门狗只做一件事：发现不健康就整体重建。重建比补丁可靠。 */
function startWatchdog() {
  if (watchdog) return;
  const check = () => {
    if (!config.floatButton) return;
    if (!isHealthy()) build();
  };
  watchdog = new MutationObserver(check);
  watchdog.observe(document.documentElement, { childList: true, subtree: false });
  if (document.body) watchdog.observe(document.body, { childList: true });
  // 存下引用：反复开关悬浮球会一层层堆积匿名监听器
  onFullscreen = () => {
    if (!host?.isConnected) return check();
    const target = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  };
  document.addEventListener('fullscreenchange', onFullscreen);
}

function stopWatchdog() {
  watchdog?.disconnect();
  watchdog = null;
  if (onFullscreen) {
    document.removeEventListener('fullscreenchange', onFullscreen);
    onFullscreen = null;
  }
}

/* -------------------------------- 对外接口 -------------------------------- */

const POSITIONS = ['bottom', 'middle', 'top'];

function applyPosition() {
  if (!host || !shell) return;
  host.dataset.pos = POSITIONS.includes(config.floatPosition) ? config.floatPosition : 'bottom';
  const offset = Number(config.floatOffset);
  // 用户拖过就以拖动结果为准，预设档位只是初值。fixed 定位只写内层 shell。
  if (Number.isFinite(offset) && offset > 0) {
    shell.style.top = `${offset}vh`;
    shell.style.bottom = 'auto';
  } else {
    shell.style.removeProperty('top');
    shell.style.removeProperty('bottom');
  }
}

/**
 * 唯一入口。幂等：配置说要显示就保证显示且健康，说不要就拆干净。
 * main.js 的三条配置路径全部调它，不再各自判断"该不该显示"。
 */
export function sync(nextConfig, nextHandlers) {
  if (nextHandlers) handlers = nextHandlers;
  config = { ...config, ...(nextConfig || {}) };

  if (!config.floatButton) {
    stopWatchdog();
    teardownNode();
    return false;
  }
  if (!isHealthy()) build();
  else applyPosition();
  startWatchdog();
  return true;
}

export function syncPhase() {
  if (!isHealthy()) return;
  const s = handlers.state?.();
  const busy = s?.phase === 'translating' || s?.phase === 'scanning';
  host.dataset.running = busy ? '1' : '0';
  const btn = root.querySelector('.btn');
  if (btn) {
    btn.title = busy
      ? '正在翻译，点击停止'
      : s?.done || s?.failed
        ? '重新翻译本页（长按更多）'
        : '翻译本页（长按更多，可上下拖动）';
  }
}

/** 点击失败要有反馈 —— 静默吞掉会让人以为悬浮球坏了 */
export function flash(message) {
  if (!isHealthy() || !message) return;
  const tip = root.querySelector('.tip');
  tip.textContent = message;
  tip.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    tip.hidden = true;
  }, 3200);
}

export function isMounted() {
  return isHealthy();
}
