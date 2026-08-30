import { isTranslationNode } from './renderer.js';

/**
 * 动态内容只有一条线：MutationObserver 负责"页面又长出新东西了"
 * （无限滚动、SPA 换路由、评论异步加载）。
 *
 * "进没进视口"不再是需要观察的生命周期事件——它降级成调度器取批时的
 * 一次几何读取（isNearViewport），没有登记、没有回调、没有状态。
 */

export function createMutationWatcher(onDirty, { debounceMs = 400 } = {}) {
  let timer = null;
  let running = false;

  const observer = new MutationObserver((records) => {
    if (!running) return;
    let relevant = false;
    for (const r of records) {
      if (r.type === 'characterData') {
        relevant = true;
        break;
      }
      for (const n of r.addedNodes) {
        // 忽略我们自己插入的译文，否则会形成无限循环
        if (isTranslationNode(n)) continue;
        if (n.nodeType === Node.ELEMENT_NODE && n.closest?.('#byom-hud')) continue;
        relevant = true;
        break;
      }
      if (relevant) break;
    }
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(onDirty, debounceMs);
  });

  return {
    start() {
      running = true;
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    },
    stop() {
      running = false;
      clearTimeout(timer);
      observer.disconnect();
    }
  };
}

/**
 * 纯读取：元素当前是否在视口附近（上下各留 margin 预读量）。
 * 每次取批时现算，滚动后的优先级自然就是新的，无需任何观察者。
 */
export function isNearViewport(el, margin = 600) {
  if (!el?.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  const viewH = window.innerHeight || document.documentElement?.clientHeight || 0;
  return rect.bottom > -margin && rect.top < viewH + margin;
}
