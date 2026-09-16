/** 内容与导航的结构线索。它们只参与候选判断，不能裁掉整棵可见子树。 */

export const CONTENT_SELECTORS = [
  'main',
  '[role="main"]',
  '#mw-content-text .mw-parser-output', // MediaWiki 正文
  '#mw-content-text',
  'article',
  '#content',
  '#main-content',
  '.markdown-body', // GitHub
  '.article-content',
  '.post-content',
  '#readme'
].join(',');

/** 可能是附属内容的容器；页面也可能误用这些标签与类名放置正文。 */
export const ASIDE_SELECTORS = [
  'nav',
  'aside',
  '[role="navigation"]',
  '[role="complementary"]',
  '#toc',
  '.toc',
  '#vector-toc',
  '.mw-jump-link',
  '.mw-editsection',
  '.navbox',
  '.sidebar',
  '.breadcrumb',
  '.pagination'
].join(',');

function textLength(el) {
  return (el.textContent || '').replace(/\s+/g, '').length;
}

/**
 * 链接密度判断：容器里几乎所有文本都在链接里、且条目都很短 → 导航。
 * 这条不依赖任何语义标签，正是 archnavbar 那类老式结构的解药。
 */
export function isLinkList(el, opts = {}) {
  const minLinks = opts.minLinks ?? 3;
  const maxItemChars = opts.maxItemChars ?? 30;
  if (!el || typeof el.querySelectorAll !== 'function') return false;

  const links = el.querySelectorAll('a');
  if (links.length < minLinks) return false;

  const total = textLength(el);
  if (!total) return false;

  let linkChars = 0;
  let longItems = 0;
  for (const a of links) {
    const len = textLength(a);
    linkChars += len;
    if (len > maxItemChars) longItems++;
  }

  // 正文段落里也会有链接，但占比不会这么高，而且条目通常更长
  if (linkChars / total < 0.75) return false;
  if (longItems > links.length * 0.3) return false;
  return true;
}
