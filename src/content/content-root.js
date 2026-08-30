/**
 * 正文根探测。
 *
 * 之前"正文优先"只是个名字：实际行为是一堆基于布局的启发式补丁，
 * 而那些补丁靠 nav/header/role=navigation 这类语义容器识别界面。
 * ArchWiki 的顶栏是 <div id="archnavbar"><ul id="archnavbarlist">，
 * 纯 div 加 ul，一条规则都不触发 —— 于是整页导航全被当正文翻了。
 *
 * 真正的正文优先应该先把范围收到正文根里，语义补丁只作为根内的二次过滤。
 */

const ROOT_SELECTORS = [
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
];

/** 根内仍要排除的附属区块：目录、侧栏、相关文章、编辑提示 */
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
 * 选正文根：候选里文本量最大的那个，且要占全页可见文本的相当比例。
 * 占比太低说明选错了（比如选中一个只放摘要的 article），宁可退回 body。
 */
export function findContentRoot(doc = document) {
  const body = doc.body || doc.documentElement;
  if (!body) return null;
  const total = textLength(body);
  if (!total) return body;

  let best = null;
  let bestLen = 0;
  for (const sel of ROOT_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      const len = textLength(el);
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
    // 越靠前的选择器越可信，一旦拿到足够份量就不再往后找
    if (best && bestLen / total >= 0.35) break;
  }

  if (!best || bestLen / total < 0.2) return body;
  return best;
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
