/**
 * 渲染层只做一件事：把译文作为新节点放到原文旁边，永不修改原文。
 * 这样即使提取器判断失误，页面也不会被破坏 —— 最坏情况只是多一行没用的译文。
 */

const CLASS = 'byom-t';

export function isTranslationNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE && node.classList?.contains(CLASS);
}

function nextMeaningfulSibling(node) {
  let n = node.nextSibling;
  while (n) {
    if (n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) {
      n = n.nextSibling;
      continue;
    }
    return n;
  }
  return null;
}

/** 找到这个单元已有的译文节点（用于去重和"原文变了就重译"） */
export function translationFor(unit) {
  if (unit.mode === 'append') {
    const last = unit.el.lastElementChild;
    return isTranslationNode(last) ? last : null;
  }
  const next = nextMeaningfulSibling(unit.anchor);
  return isTranslationNode(next) ? next : null;
}

/**
 * 立刻占位：抢在网络请求之前插节点，重复扫描就不会重复入队。
 */
export function attach(unit) {
  let node = unit.node;
  if (!node || !node.isConnected) {
    node = document.createElement('span');
    node.className = CLASS;
    node.setAttribute('translate', 'no');
    node.dir = 'auto';
  }
  node.dataset.byomId = String(unit.id);
  node.dataset.byomHash = unit.hash;
  // 角色决定字号层级；字族由 CSS 统一指定。两者刻意分开：
  // 差异化是"一眼看出哪句是译文"，层级是"译文之间仍分得清标题和正文"。
  node.dataset.byomRole = unit.role || 'body';
  /**
   * 仅译文模式要隐藏原文，三类单元处理方式不同：
   *  - 元素级（译文是兄弟节点）：直接把源元素藏掉。
   *  - append（LI/TD/引用块，译文在元素内部）：藏掉元素会连译文一起藏，
   *    所以改成把容器字号压成 0 再单独把译文的字号还原 —— 裸文本节点
   *    没法用 CSS 选中，字号是唯一能一并收拾掉它们的办法。
   *    之前这一类被整个跳过，于是列表和表格的原文全留着，
   *    在满页列表的站点上看起来就像"仅译文"根本没生效。
   *  - run（混排里的裸文本）：原文是游离文本节点，CSS 无从下手，保持双语。
   */
  if (unit.mode === 'append') {
    unit.el.dataset.byomSrcIn = '';
    if (typeof getComputedStyle === 'function') {
      const size = parseFloat(getComputedStyle(unit.el).fontSize);
      if (size) node.style.setProperty('--byom-own-size', size + 'px');
    }
  } else if (unit.anchor === unit.el) {
    unit.el.dataset.byomSrc = '';
  }
  if (unit.srcSize) node.style.setProperty('--byom-src-size', unit.srcSize + 'px');
  node.dataset.byomState = 'loading';
  node.textContent = '';

  // 位置必须每次校正：复用的旧节点可能停在错误的地方（原文被追加内容时会这样），
  // 位置不对就会导致每轮扫描都认不出它，变成无限重译。
  try {
    if (unit.mode === 'append') {
      if (unit.el.lastElementChild !== node) unit.el.appendChild(node);
    } else if (unit.anchor.parentNode) {
      if (nextMeaningfulSibling(unit.anchor) !== node) unit.anchor.after(node);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  unit.node = node;
  return node;
}

/**
 * 写入译文。节点上的 hash 是 attach 时写的当前原文指纹；
 * 如果原文在请求途中被改写，节点已经被新单元占用并换了 hash，
 * 这时旧响应必须丢掉，否则会把新译文覆盖回去。
 */
export function fill(unit, text) {
  const node = unit.node;
  if (!node || !node.isConnected) return false;
  if (node.dataset.byomHash !== unit.hash) return false;
  node.dataset.byomState = 'done';
  node.removeAttribute('title');
  node.textContent = text;
  return true;
}

export function fail(unit, message) {
  const node = unit.node;
  if (!node || !node.isConnected) return false;
  if (node.dataset.byomHash !== unit.hash) return false;
  node.dataset.byomState = 'error';
  node.title = message || '翻译失败，双击重试';
  node.textContent = '译文获取失败 · 双击重试';
  return true;
}

export function detach(unit) {
  unit.node?.remove();
  unit.node = null;
}

let colorMql = null;

/** 呈现样式、字体与配色来自设置，挂在 <html> 上，切换时不用碰任何译文节点 */
export function applyPresentation(cfg) {
  const root = document.documentElement;
  root.dataset.byomStyle = cfg.translationStyle || 'bar';
  // 显示模式跟着配置走：翻译前就该定好，页面上切换也是在改这个设置
  if (cfg.displayMode) setDisplayMode(cfg.displayMode);
  if (cfg.translationFont && cfg.translationFont.trim()) {
    root.style.setProperty('--byom-font', cfg.translationFont.trim());
  } else {
    root.style.removeProperty('--byom-font');
  }

  // 深浅色各存一份：页面主题跟随系统时这个判断是准的，
  // 站点自带主题开关的场景是已知误差，README 里写明。
  const apply = () => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    root.style.setProperty('--byom-accent', dark ? cfg.accentColorDark : cfg.accentColorLight);
    // 单层、亚像素级轮廓阴影：浅色页用浅边，深色页用暗边。
    // 它只在 CSS 的 done 状态参与绘制，不给每个字叠多层 stroke；切换主题时也只改
    // <html> 上的变量，不遍历译文节点。目标是让扩展自己的字体栈在复杂页面背景上
    // 保持轮廓，而不是靠描边把字重硬生生加粗。
    root.style.setProperty(
      '--byom-text-shadow',
      dark ? '0 0 0.45px rgba(0, 0, 0, 0.38)' : '0 0 0.4px rgba(255, 255, 255, 0.28)'
    );
    const mode = cfg.translationColor || 'inherit';
    if (mode === 'custom') {
      root.style.setProperty('--byom-text', dark ? cfg.textColorDark : cfg.textColorLight);
    } else if (mode === 'muted') {
      root.style.setProperty('--byom-text', 'color-mix(in srgb, currentColor 72%, transparent)');
    } else if (mode === 'accent') {
      root.style.setProperty('--byom-text', dark ? cfg.accentColorDark : cfg.accentColorLight);
    } else {
      root.style.removeProperty('--byom-text');
    }
  };
  apply();
  colorMql?.removeEventListener?.('change', colorMql._h);
  colorMql = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (colorMql) {
    colorMql._h = apply;
    colorMql.addEventListener('change', apply);
  }
}

const MODES = ['bilingual', 'translation', 'original'];

export function displayMode() {
  const m = document.documentElement.dataset.byomDisplay;
  return MODES.includes(m) ? m : 'bilingual';
}

export function setDisplayMode(mode) {
  document.documentElement.dataset.byomDisplay = MODES.includes(mode) ? mode : 'bilingual';
  return displayMode();
}

/** 三态循环：双语 → 仅译文 → 仅原文 */
export function cycleDisplay() {
  return setDisplayMode(MODES[(MODES.indexOf(displayMode()) + 1) % MODES.length]);
}

export function isVisible() {
  return displayMode() !== 'original';
}

export function removeAll() {
  document.querySelectorAll('.' + CLASS).forEach((n) => n.remove());
  document.querySelectorAll('[data-byom-src]').forEach((n) => delete n.dataset.byomSrc);
  document.querySelectorAll('[data-byom-src-in]').forEach((n) => delete n.dataset.byomSrcIn);
  // 显示方式是设置，不是这一页的临时状态。清除译文不该顺手把它重置掉 ——
  // 之前清一次就悄悄退回双语，看起来就像预设值失效了。
}

export function findUnitIdFromEvent(target) {
  const node = target?.closest?.('.' + CLASS);
  return node ? Number(node.dataset.byomId) : null;
}
