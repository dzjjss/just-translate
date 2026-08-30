/**
 * manifest 里声明的 content script 不能直接用 import，所以这里只做一件事：
 * 用动态 import 把真正的 ES module 拉进同一个 isolated world。
 * 代价是一次异步加载，换来的是 content 侧可以和后台共享同一套模块，不需要打包器。
 */
(() => {
  if (window.__BYOM_LOADED__) return;
  window.__BYOM_LOADED__ = true;
  import(chrome.runtime.getURL('src/content/main.js')).catch((e) => {
    window.__BYOM_LOADED__ = false;
    console.error('[BYOM] 模块加载失败', e);
  });
})();
