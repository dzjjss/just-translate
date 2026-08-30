/**
 * 页面内 UI 的宿主。悬浮球、状态条这类"我们自己的界面"全部挂进 Shadow DOM。
 *
 * 译文节点刻意不走这里 —— 它们必须留在正常 DOM 里才能被 Ctrl+F 搜到、被复制、
 * 被朗读工具读到。这是两类东西，处理方式相反：
 *   译文  = 融进页面，继承排版
 *   界面  = 隔离于页面，谁也别影响谁
 *
 * 悬浮球不走这里 —— 它的挂载、自愈、交互全部收在 float-widget.js 里，
 * 因为"节点还在但内容是空壳"这种情况必须整体重建，补挂救不回来。
 *
 * 裸 div 挂 body 有五个真实隐患，这个模块逐条处理：
 *  1. 站点 CSS 用更高优先级或 !important 打穿我们的样式 → Shadow DOM 隔离
 *  2. body 上有 transform/filter 时 position:fixed 会以它为参照系 → 挂到 documentElement
 *  3. 单页应用清空 body 会把我们一起清掉 → 观察脱离并自动重挂
 *  4. 站点自己的浮层 z-index 顶到最大 → 我们用最大值
 *  5. 站内元素进入全屏后，普通层的 fixed 元素不可见 → 跟着搬进全屏元素
 */

const HOSTS = new Set();
let fullscreenHooked = false;

function hookFullscreen() {
  if (fullscreenHooked) return;
  fullscreenHooked = true;
  document.addEventListener('fullscreenchange', () => {
    const target = document.fullscreenElement || document.documentElement;
    for (const entry of HOSTS) {
      if (entry.host.parentNode !== target) target.appendChild(entry.host);
    }
  });
}

export function createHost(id, css) {
  const existing = [...HOSTS].find((h) => h.id === id);
  if (existing && existing.host.isConnected) return existing;

  const host = document.createElement('div');
  host.id = id;
  // 提取器靠这个属性跳过我们自己的界面，否则它会把自己的按钮文字也翻一遍
  host.setAttribute('data-byom-skip', '');
  host.setAttribute('translate', 'no');
  host.setAttribute('aria-live', 'polite');

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // all: initial 切断站点的继承；内部一律用 px —— 不少站点把 html 的 font-size
  // 改成 62.5%，rem/em 在 shadow 里照样会被带跑
  style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;}\n${css}`;
  root.appendChild(style);

  const mountPoint = document.fullscreenElement || document.documentElement;
  mountPoint.appendChild(host);

  // 脱离即重挂：SPA 重绘、站点脚本清理 DOM 都会把我们扫掉
  const observer = new MutationObserver(() => {
    if (host.isConnected) return;
    const target = document.fullscreenElement || document.documentElement;
    target.appendChild(host);
  });
  observer.observe(document.documentElement, { childList: true, subtree: false });
  const bodyObserver = new MutationObserver(() => {
    if (!host.isConnected) (document.fullscreenElement || document.documentElement).appendChild(host);
  });
  if (document.body) bodyObserver.observe(document.body, { childList: true });

  hookFullscreen();

  const entry = {
    id,
    host,
    root,
    destroy() {
      observer.disconnect();
      bodyObserver.disconnect();
      host.remove();
      HOSTS.delete(entry);
    }
  };
  HOSTS.add(entry);
  return entry;
}

export function destroyHost(id) {
  const entry = [...HOSTS].find((h) => h.id === id);
  entry?.destroy();
}
