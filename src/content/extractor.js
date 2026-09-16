import { hashString } from '../shared/hash.js';
import { LIMITS } from '../shared/constants.js';
import { ASIDE_SELECTORS, CONTENT_SELECTORS, isLinkList } from './content-root.js';
import { isTranslationNode, translationFor, withSourceVisible } from './renderer.js';
import { closestInPage, containsInPage, parentInPage, queryPage, renderedChildren } from './dom-roots.js';

/**
 * 提取器把 DOM 变成"翻译单元"。这是整个项目最难做对的部分，所以规则全部集中在这里，
 * 其他模块只消费 unit，不再碰 DOM 结构判断。
 *
 * 核心决策：
 * 1. 以"叶子块"为单位，而不是以文本节点为单位 —— 否则 <p>foo <a>bar</a> baz</p>
 *    会被拆成三段，句子结构在模型眼里就没了。
 * 2. 块元素里混着裸文本和子块时（<div>文字<pre>code</pre>文字</div>），
 *    连续的行内内容各自成为一个 run 单元，锚点是 run 的最后一个节点。
 * 3. 不做占位符保护。译文是新插入的兄弟节点，原文永远不动，
 *    所以行内 <code>、<a> 的内容混进原文里也不会造成破坏性后果。
 */

/**
 * 跳过规则分三类，混为一谈就会出事：
 * - KEEP：行内、文字要留在句子里（<p>用 <code>ip route</code> 添加路由</p> 拆开就没法翻了）
 * - DROP：行内、文字不能进正文，但也不该打断句子（内联 <script>、图标 <svg>、表单控件）
 * - CUT ：块级，既不翻也要打断段落（<pre> 代码块、<iframe>）
 */
const KEEP_INLINE = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'TT']);

const DROP_INLINE = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'AUDIO', 'VIDEO',
  'TRACK', 'SOURCE', 'MAP', 'AREA', 'EMBED', 'OBJECT', 'TEXTAREA', 'INPUT', 'SELECT',
  'OPTION', 'OPTGROUP', 'DATALIST', 'PROGRESS', 'METER'
]);

const CUT_BLOCK = new Set([
  'PRE', 'XMP', 'PLAINTEXT', 'IFRAME', 'FRAME', 'FRAMESET', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE'
]);

const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS',
  'MARK', 'NOBR', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'WBR', 'IMG', 'PICTURE', 'LABEL'
]);

/** 这些容器里插兄弟节点会破坏结构，译文改为追加到内部 */
const APPEND_INSIDE = new Set([
  'LI', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'BLOCKQUOTE', 'BUTTON', 'A'
]);

const SKIP_ROLES = new Set(['code', 'math', 'img']);

/** 探测行内元素肚子里有没有块级后代 —— Google 搜索结果就是 <a> 里裹整块卡片 */
const BLOCK_PROBE =
  'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,tr,td,th,section,article,header,footer,' +
  'nav,aside,figure,figcaption,blockquote,pre,form,dl,dd,dt,hr,main,details,summary';

const HEADING_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LEGEND', 'CAPTION', 'FIGCAPTION', 'DT', 'SUMMARY'
]);

const UI_CONTAINERS = 'nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[role="menubar"],[role="tablist"]';

let nextId = 1;

export function resetIds() {
  nextId = 1;
}

function normalize(text) {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const HAS_LETTER = /\p{L}/u;
const PURE_NOISE = /^[\s\d\p{P}\p{S}]*$/u;
const URLISH = /^(https?:\/\/|www\.|mailto:|[\w.+-]+@[\w-]+\.\w+)\S*$/i;

const SENTENCE_END = /[.!?。！？…]["'”’)）]?$/;

/**
 * 单 token：去掉标点后不含任何空白。
 * 用户名、品牌、标签碎片、导航词基本都会落在这里，翻了既花钱又制造噪音。
 * 标题和以句末标点收尾的短句除外 —— "Introduction" 作为 h2 仍然该翻。
 */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function isSingleToken(text) {
  if (SENTENCE_END.test(text)) return false;
  const stripped = text.replace(/[\p{P}\p{S}]/gu, ' ').trim();
  if (!stripped) return false;
  // 中文、日文、泰文等本来就不靠空格分词；“没有空格”不能推出“只有一个 token”。
  if (NO_SPACE_SCRIPT.test(stripped)) return false;
  return !/\s/.test(stripped);
}

function textRejection(text, opts, el) {
  if (!text) return 'empty';
  if (text.length < (opts.minTextLength ?? 2)) return 'too-short';
  if (!HAS_LETTER.test(text) || PURE_NOISE.test(text)) return 'noise';
  if (URLISH.test(text)) return 'url-or-email';

  const heading = el ? HEADING_TAGS.has(tagOf(el)) : false;
  if (opts.skipSingleToken && !heading && isSingleToken(text)) return 'single-token';
  return null;
}

function elementRejection(el, opts) {
  if (el.isContentEditable || el.matches('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) return 'editable';
  if (el.matches('#byom-hud, #byom-fab, [translate="no"], .notranslate, [data-byom-skip]')) return 'explicit-skip';
  if (el.matches('[aria-hidden="true"], [hidden]')) return 'hidden';
  if (SKIP_ROLES.has(el.getAttribute('role'))) return 'non-text-role';
  // 逃生口本身不能炸：一个写错的选择器会让 matches 抛 SyntaxError，
  // 被 scan 最外层的 catch 吞掉 —— 表现为整页零提取且只有控制台有线索。
  if (opts.skipSelectors) {
    try {
      if (el.matches(opts.skipSelectors)) return 'user-selector';
    } catch {
      opts.skipSelectors = ''; // 本轮扫描不再重试，避免每个元素抛一次
      if (opts.trace) opts.trace.invalidSkipSelector = true;
    }
  }
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.contentVisibility === 'hidden') return 'hidden';
  // display:contents 没有自己的盒子，因此 checkVisibility() 为 false；后代仍然可见。
  if (style.display !== 'contents' && el.checkVisibility && !el.checkVisibility()) return 'hidden';
  return null;
}

function countDecision(opts, group, reason) {
  if (!opts.trace) return;
  const counts = opts.trace[group];
  counts[reason] = (counts[reason] || 0) + 1;
}

function isSkippedElement(el, opts) {
  if (isTranslationNode(el)) return true;
  const reason = elementRejection(el, opts);
  if (reason) countDecision(opts, 'skippedElements', reason);
  return Boolean(reason);
}

function acceptsText(el, text, opts) {
  const reason = textRejection(text, opts, el) || layoutRejection(el, text, opts);
  if (reason) countDecision(opts, 'skippedCandidates', reason);
  return !reason;
}

/** SVG / MathML 元素的 tagName 不是大写（svg、math），必须统一后再查表 */
function tagOf(el) {
  return String(el.tagName || '').toUpperCase();
}

function isInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  // 开放组件单独进入其渲染树，避免原生 textContent 忽略内部内容。
  if (node.shadowRoot) return false;
  const tag = tagOf(node);

  // 自定义元素（标签名带连字符）不在任何 HTML 语义表里，浏览器默认按 inline 渲染，
  // 而且经常嵌在句子中间（GitHub 的 <relative-time>、组件库的徽章）。按块处理会把
  // 句子切成碎片，碎片再被单 token 过滤器丢掉 —— 拆句和丢字是连环的。
  // 语义交给计算样式：组件自己声明成块级的仍按块处理。
  const custom = tag.includes('-');
  if (!custom && !INLINE_TAGS.has(tag)) return false;

  // 标签是行内的，不代表内容是行内的。<a> 里裹着整块卡片时若仍按行内处理，
  // 标题、描述、URL 会被 textContent 揉成一段 —— 这就是 Google 搜索结果翻出来
  // "标题+站点名+网址" 连在一起的原因。
  if (node.firstElementChild && node.querySelector(BLOCK_PROBE)) return false;

  // 站点可能把 span 改成 display:block；只对可疑元素才查计算样式
  if (custom || tag === 'SPAN' || tag === 'A' || tag === 'LABEL') {
    const d = getComputedStyle(node).display;
    if (d && !d.startsWith('inline') && d !== 'contents') return false;
  }
  return true;
}

/**
 * 容器放不下译文的地方，插进去只会撑坏排版或者根本看不见 —— 两种情况都是白花钱。
 * 这些判断天生是启发式的，会有误判，逃生口是设置里的「跳过选择器」。
 */
function layoutRejection(el, text, opts) {
  if (auxiliaryLabel(el, text, opts)) return 'auxiliary-label';
  if (!opts.skipTightLayout) return null;
  if (!el || !el.isConnected || typeof getComputedStyle !== 'function') return null;

  const cs = getComputedStyle(el);
  if (clipsTranslation(el, cs)) return 'clipped-layout';

  // 语义标签靠不住：ArchWiki 的顶栏是 <div id="archnavbar"><ul>，一个 nav 都没有。
  // 改用链接密度 —— 容器里几乎全是短链接就是导航，不管它用什么标签。
  if (!HEADING_TAGS.has(tagOf(el)) && !SENTENCE_END.test(text)) {
    const list = closestInPage(el, 'ul,ol,nav,div');
    // 正文 main/article 里的“了解更多 / 参考资料”本来就是内容。它同样可能是纯短链接
    // 列表，不能因为链接密度高就当成顶栏导航。
    if (list && isLinkList(list) && !isArticleList(list, opts.contentRoot)) return 'link-list';
  }

  return null;
}

function auxiliaryLabel(el, text, opts) {
  if (text.length > opts.uiTextMax || HEADING_TAGS.has(tagOf(el)) || SENTENCE_END.test(text)) return false;
  if (opts.skipAside && closestInPage(el, ASIDE_SELECTORS)) return true;
  return Boolean(opts.skipTightLayout && closestInPage(el, UI_CONTAINERS));
}

function clipsTranslation(el, style) {
  if (['nowrap', 'pre'].includes(style.whiteSpace)) return true;
  if (style.textOverflow === 'ellipsis') return true;
  const clamp = style.webkitLineClamp || style.WebkitLineClamp;
  if (Number.parseInt(clamp, 10) > 0) return true;
  if ([style.overflow, style.overflowY].includes('hidden') && el.scrollHeight > el.clientHeight + 4) return true;
  return ['fixed', 'sticky'].includes(style.position);
}

function isArticleList(list, root) {
  return Boolean(containsInPage(root, list) && closestInPage(list, CONTENT_SELECTORS)
    && !closestInPage(list, UI_CONTAINERS) && !closestInPage(list, ASIDE_SELECTORS));
}

function leafPlacement(el) {
  // 沿用 DOM 上已有的回填归属，响应式布局变化不能制造第二份译文。
  if (el.hasAttribute('data-byom-src-in') || APPEND_INSIDE.has(tagOf(el))) return 'append';
  if (el.hasAttribute('data-byom-src')) return 'after';
  // 命名插槽只投影原元素；新兄弟节点可能被分配到别处或完全不可见。
  if (el.assignedSlot) return 'append';
  let parent = parentInPage(el);
  while (parent && getComputedStyle(parent).display === 'contents') parent = parentInPage(parent);
  const parentDisplay = parent ? getComputedStyle(parent).display : '';
  if (/flex|grid/.test(parentDisplay) && !/flex|grid/.test(getComputedStyle(el).display)) return 'append';
  return 'after';
}

/** 译文的排版角色：决定字号层级，与字体差异化是两条正交的规则 */
function roleOf(el, text, opts) {
  if (HEADING_TAGS.has(tagOf(el))) return 'heading';
  if (text.length <= opts.uiTextMax && closestInPage(el, UI_CONTAINERS)) return 'ui';
  return 'body';
}

function makeUnit({ el, anchor, mode, text, opts }) {
  const role = roleOf(el, text, opts);
  let srcSize = 0;
  if (role === 'heading' && typeof getComputedStyle === 'function') {
    srcSize = parseFloat(getComputedStyle(el).fontSize) || 0;
  }
  return {
    id: opts.snapshot ? 0 : nextId++,
    el,
    anchor,
    mode, // 'after' | 'append'
    text,
    hash: hashString(text),
    tag: tagOf(el),
    role,
    srcSize,
    node: null,
    state: 'pending'
  };
}

/**
 * 已有译文节点时：
 * - hash 相同（包括正在请求中、以及失败的）一律跳过，DOM 抖动不会变成重试风暴；
 *   失败的段落由用户双击重翻。
 * - hash 不同说明原文被改写了（SPA 常见），复用旧节点重新翻译。
 */
function reuseOrSkip(unit, opts) {
  const existing = translationFor(unit);
  if (opts.snapshot) { unit.node = existing; return unit; }
  if (!existing) return unit;
  if (existing.dataset.byomHash === unit.hash) return null;
  unit.node = existing;
  return unit;
}

/**
 * 每个子节点的角色。
 * 'own' 是我们自己插入的译文：它必须对遍历完全隐形 —— 既不能进正文，
 * 也不能打断句子，更不能让父元素"看起来有了块级子节点"而不再是叶子块。
 * 之前它落进 drop 分支，导致 run 的锚点变成译文节点自己，重复扫描就会重复产出。
 */
function childRole(node, opts) {
  if (node.nodeType === Node.TEXT_NODE) return 'keep';
  if (node.nodeType !== Node.ELEMENT_NODE) return 'drop';
  if (isTranslationNode(node)) return 'own';
  const tag = tagOf(node);
  if (DROP_INLINE.has(tag)) {
    countDecision(opts, 'skippedElements', 'non-content-tag');
    return 'drop';
  }
  if (isSkippedElement(node, opts)) return KEEP_INLINE.has(tag) || isInline(node) ? 'drop' : 'cut';
  countBoundary(node, opts);
  if (KEEP_INLINE.has(tag)) return 'keep';
  if (CUT_BLOCK.has(tag)) {
    countDecision(opts, 'skippedElements', 'block-boundary');
    return 'cut';
  }
  return isInline(node) ? 'keep' : 'block';
}

function countBoundary(el, opts) {
  if (!opts.trace) return;
  if (el.shadowRoot) opts.trace.openShadowHosts++;
  if (['IFRAME', 'FRAME'].includes(tagOf(el))) opts.trace.frameBoundaries++;
}

/** run = 连续的行内内容。counted 的才进正文，drop 的只是不打断句子。 */
function pieceText({ node, counted }, opts) {
  if (!counted) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  // <br> 是显式换行，textContent 为空 —— 直接拼接会把两侧的句子粘死，补一个空格
  if (node.nodeType === Node.ELEMENT_NODE && tagOf(node) === 'BR') return ' ';
  // textContent 会越过嵌套的 notranslate、隐藏内容和控件；行内后代也走同一套规则。
  let result = '';
  for (const child of renderedChildren(node)) {
    const role = childRole(child, opts);
    if (role === 'keep') result += pieceText({ node: child, counted: true }, opts);
    // 未被标签表识别的嵌套块仍须保留文本，并在边界补空格。
    if (role === 'block') result += ' ' + pieceText({ node: child, counted: true }, opts) + ' ';
  }
  return result;
}

function runText(run, opts) {
  return normalize(run.map(piece => pieceText(piece, opts)).join(''));
}

function collectRun(run, el, out, opts, stray) {
  if (!run.length) return;
  const text = runText(run, opts);
  if (!acceptsText(el, text, opts)) return;
  const unit = reuseOrSkip(
    makeUnit({ el, anchor: run[run.length - 1].node, mode: 'after', text, opts }), opts
  );
  if (!unit) return;
  // run 中间夹着旧译文（原文后面又被追加了内容）：复用它，避免留下孤儿节点
  if (!unit.node && stray && stray.isConnected) unit.node = stray;
  out.push(unit);
}

function walk(el, out, opts) {
  if (isSkippedElement(el, opts)) return;

  let run = [];
  let stray = null; // run 中间遇到的旧译文节点
  let sawBlockChild = false;

  for (const node of renderedChildren(el)) {
    const role = childRole(node, opts);
    if (role === 'own') {
      if (run.length) stray = node; // 只有夹在 run 中间才算 stray，尾随的属于正常情况
      continue;
    }
    if (role === 'keep' || role === 'drop') {
      run.push({ node, counted: role === 'keep' });
      continue;
    }
    // block / cut：先把前面的行内内容结成一个单元
    sawBlockChild = true;
    collectRun(run, el, out, opts, stray);
    run = [];
    stray = null;
    if (role === 'block') walk(node, out, opts);
  }

  if (!sawBlockChild) {
    // 整个元素就是一个叶子块：锚点用元素本身，位置最稳
    const text = runText(run, opts);
    if (!acceptsText(el, text, opts)) return;
    const mode = leafPlacement(el);
    const unit = reuseOrSkip(makeUnit({ el, anchor: el, mode, text, opts }), opts);
    if (unit) out.push(unit);
    return;
  }

  collectRun(run, el, out, opts, stray);
}

/**
 * 扫描 root 下所有待翻译单元。
 * 已翻译且未变化的内容会被自然跳过，所以可以对同一页面重复调用（动态内容就靠这个）。
 */
export function scan(root, config, options) {
  return withSourceVisible(() => scanVisible(root, config, options));
}

function scanVisible(root, config, { snapshot = false, trace = null } = {}) {
  const opts = {
    snapshot,
    trace,
    minTextLength: config.minTextLength,
    // 只过滤结构噪音与受限布局，不根据源文语言或字符占比推断是否该翻译。
    skipSingleToken: config.skipSingleToken ?? config.smartFilter !== false,
    skipTightLayout: config.skipTightLayout ?? config.smartFilter !== false,
    skipSelectors: (config.skipSelectors || '').trim(),
    skipAside: config.contentRootOnly !== false,
    uiTextMax: LIMITS.UI_TEXT_MAX_CHARS
  };
  const out = [];
  const start = root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;
  if (!start) return out;

  // main/article 只是内容线索。多篇文章、异名容器、根外正文都应继续接受同一套判断。
  opts.contentRoot = start;
  try {
    countBoundary(start, opts);
    walk(start, out, opts);
  } catch (e) {
    if (trace) trace.completed = false;
    console.warn('[BYOM] 扫描中断', e);
  }
  return out;
}

/** 只在复制诊断时重算；不保存 DOM、正文、URL 或跨次扫描的状态。 */
export function inspectExtraction(root, config) {
  const trace = {
    scope: 'top-document-open-shadow-dom',
    completed: true,
    invalidSkipSelector: false,
    skippedElements: {},
    skippedCandidates: {},
    frameBoundaries: 0,
    openShadowHosts: 0
  };
  const units = scan(root, config, { snapshot: true, trace });
  return {
    ...trace,
    candidateUnits: units.length,
    sourceChars: units.reduce((total, unit) => total + unit.text.length, 0),
    existingTranslationUnits: units.filter(unit => unit.node?.dataset.byomHash === unit.hash).length
  };
}

/** 页面语境：给 prompt 和本地分类器用，不含正文，成本可忽略 */
export function collectPageContext() {
  const meta = (name) =>
    document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content || '';
  const headings = [...queryPage('h1, h2')]
    .slice(0, 12)
    .map((h) => normalize(h.textContent || ''))
    .filter(Boolean);

  return {
    title: document.title || '',
    url: location.href,
    hostname: location.hostname,
    description: meta('description') || meta('og:description'),
    ogType: meta('og:type'),
    headings,
    codeBlocks: document.querySelectorAll('pre code, pre, .highlight').length,
    hasByline: Boolean(document.querySelector('[rel="author"], .byline, [itemprop="author"]')),
    commentNodes: document.querySelectorAll(
      '[class*="comment"], [id*="comment"], [class*="reply"]'
    ).length
  };
}
