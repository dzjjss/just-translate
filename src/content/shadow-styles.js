import { pageRoots } from './dom-roots.js';

// 一份本地样式、一份共享 CSSStyleSheet；不保存任何 ShadowRoot 引用。
const styles = { loading: null, sheet: null };

function loadStyles() {
  if (!styles.loading) {
    styles.loading = fetch(new URL('../../assets/content.css', import.meta.url))
      .then(response => {
        if (!response.ok) throw new Error('无法读取组件译文样式');
        return response.text();
      })
      .then(css => {
        const sheet = new window.CSSStyleSheet();
        sheet.replaceSync(css);
        styles.sheet = sheet;
        return sheet;
      })
      .catch(error => { console.warn('[BYOM] 组件译文样式未加载', error); return null; });
  }
  return styles.loading;
}

function adopt(node, sheet) {
  // 样式请求期间可能已停止并清除了译文，不能把样式重新挂回旧组件。
  if (!sheet || !node.isConnected) return;
  const root = node.getRootNode();
  if (root.host && !root.adoptedStyleSheets.includes(sheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
}

export function ensureShadowStyles(node) {
  const root = node.getRootNode();
  if (!root.host || !('adoptedStyleSheets' in root) || !window.CSSStyleSheet?.prototype.replaceSync) return Promise.resolve();
  if (styles.sheet) { adopt(node, styles.sheet); return Promise.resolve(); }
  return loadStyles().then(sheet => adopt(node, sheet));
}

export function removeShadowStyles() {
  if (!styles.sheet) return;
  for (const root of pageRoots()) {
    if (root.host) root.adoptedStyleSheets = root.adoptedStyleSheets.filter(sheet => sheet !== styles.sheet);
  }
}
