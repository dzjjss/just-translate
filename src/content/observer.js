import { isOwnNode, pageRoots } from './dom-roots.js';

function relevantMutation(record) {
  if (isOwnNode(record.target)) return false;
  if (record.type !== 'childList') return true;
  return [...record.addedNodes, ...record.removedNodes].some(node => !isOwnNode(node));
}

/**
 * 动态内容只有一条线：MutationObserver 负责"页面又长出新东西了"
 * （无限滚动、SPA 换路由、评论异步加载）。
 *
 * "进没进视口"不再是需要观察的生命周期事件——它降级成调度器取批时的
 * 一次几何读取（isNearViewport），没有登记、没有回调、没有状态。
 */

export function createMutationWatcher(onDirty, { debounceMs = 400 } = {}) {
  let timer = null;
  let events = null;

  const observer = new MutationObserver((records) => {
    if (records.some(relevantMutation)) schedule();
  });

  function schedule() {
    if (!events) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      observePage();
      onDirty();
    }, debounceMs);
  }

  function onInteraction(event) {
    if (!isOwnNode(event.composedPath?.()[0] || event.target)) schedule();
  }

  function observePage() {
    // 每次重扫重新绑定，移除的根随即释放；无需再养一个根集合。
    observer.disconnect();
    events?.abort();
    events = new window.AbortController();
    const options = { signal: events.signal };
    for (const root of pageRoots(document.body)) {
      observer.observe(root, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'translate', 'contenteditable', 'role', 'open', 'slot', 'name']
      });
      root.addEventListener('slotchange', onInteraction, options);
    }
    // attachShadow 本身不会发出 DOM mutation；交互和返回标签页提供额外发现机会。
    document.addEventListener('click', onInteraction, { ...options, capture: true });
    document.addEventListener('visibilitychange', onInteraction, options);
  }

  return {
    start() {
      clearTimeout(timer);
      observePage();
    },
    stop() {
      clearTimeout(timer);
      observer.disconnect();
      events?.abort();
      events = null;
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
