import { hashString } from '../shared/hash.js';
import { LIMITS } from '../shared/constants.js';
import { ASIDE_SELECTORS, findContentRoot, isLinkList } from './content-root.js';
import { isTranslationNode, translationFor } from './renderer.js';

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
  'OPTION', 'OPTGROUP', 'DATALIST', 'PROGRESS', 'METER', 'SLOT'
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

const SKIP_ROLES = new Set(['code', 'math', 'img', 'presentation', 'none']);

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

/**
 * 脚本占比。汉字与假名必须分开统计 ——
 * 之前把它们并成一个"CJK"集合，于是目标语言是中文时，
 * 日文正文（大量假名）会被判成"已经是目标语言"整页跳过，反向同理。
 * 脚本不等于语言，这是两回事。
 */
function scriptRatio(text, re) {
  const hit = text.match(re);
  return hit ? hit.length / text.length : 0;
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/g;
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/g;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/g;

/** 目标语言用哪套文字 */
function targetScript(lang) {
  const s = String(lang || '');
  if (/日本語|japanese/i.test(s)) return 'kana';
  if (/한국|韩语|韓語|korean/i.test(s)) return 'hangul';
  if (/中文|汉语|漢語|chinese/i.test(s)) return 'han';
  return '';
}

/**
 * 这段文本是否已经是目标语言。
 * 日文含大量汉字，所以判日文要看假名而不是汉字；
 * 反过来判中文时，出现假名就说明它不是中文。
 */
function alreadyTarget(text, script) {
  if (!script) return false;
  if (script === 'kana') return scriptRatio(text, KANA) > 0.1;
  if (script === 'hangul') return scriptRatio(text, HANGUL) > 0.3;
  // 目标是中文：汉字占比高，且几乎没有假名
  return scriptRatio(text, HAN) > 0.5 && scriptRatio(text, KANA) < 0.02;
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

function isTranslatable(text, opts, el) {
  if (!text || text.length < (opts.minTextLength ?? 2)) return false;
  if (!HAS_LETTER.test(text)) return false;
  if (PURE_NOISE.test(text)) return false;
  if (URLISH.test(text)) return false;
  if (opts.skipSameScript && alreadyTarget(text, opts.targetScript)) return false;

  const heading = el ? HEADING_TAGS.has(tagOf(el)) : false;
  if (opts.skipSingleToken && !heading && isSingleToken(text)) return false;
  return true;
}

function isSkippedElement(el, opts) {
  if (isTranslationNode(el)) return true;
  if (el.id === 'byom-hud') return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') return true;
  if (el.getAttribute('translate') === 'no') return true;
  if (el.classList?.contains('notranslate')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (SKIP_ROLES.has(el.getAttribute('role'))) return true;
  if (el.dataset?.byomSkip !== undefined) return true;
  // 逃生口本身不能炸：一个写错的选择器会让 matches 抛 SyntaxError，
  // 被 scan 最外层的 catch 吞掉 —— 表现为整页零提取且只有控制台有线索。
  if (opts.skipSelectors) {
    try {
      if (el.matches(opts.skipSelectors)) return true;
    } catch {
      opts.skipSelectors = ''; // 本轮扫描不再重试，避免每个元素抛一次
    }
  }
  // 正文根内部仍有目录、侧栏、编辑提示这类附属区块
  if (opts.skipAside && el.matches(ASIDE_SELECTORS)) return true;
  if (el.checkVisibility && !el.checkVisibility()) return true;
  return false;
}

/** SVG / MathML 元素的 tagName 不是大写（svg、math），必须统一后再查表 */
function tagOf(el) {
  return String(el.tagName || '').toUpperCase();
}

function isInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
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
function layoutRejects(el, text, opts) {
  if (!opts.skipTightLayout) return false;
  if (!el || !el.isConnected || typeof getComputedStyle !== 'function') return false;

  const short = text.length <= opts.uiTextMax;
  const cs = getComputedStyle(el);

  if (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') return true;
  if (cs.textOverflow === 'ellipsis') return true;
  const clamp = cs.webkitLineClamp || cs.WebkitLineClamp;
  if (clamp && clamp !== 'none') return true;

  // 已经在裁剪自己内容的容器，再加一行也是看不见的
  if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 4) {
    return true;
  }
  if (cs.position === 'fixed' || cs.position === 'sticky') return true;

  // flex / grid 的子项通常是被算好尺寸的 UI 元件，插一行会把整排顶乱
  const parent = el.parentElement;
  if (short && parent) {
    const pd = getComputedStyle(parent).display;
    if (pd.includes('flex') || pd.includes('grid')) return true;
  }

  // 导航、页眉、页脚里的短文本是界面而不是正文
  if (short && !HEADING_TAGS.has(tagOf(el)) && el.closest?.(UI_CONTAINERS)) return true;

  // 语义标签靠不住：ArchWiki 的顶栏是 <div id="archnavbar"><ul>，一个 nav 都没有。
  // 改用链接密度 —— 容器里几乎全是短链接就是导航，不管它用什么标签。
  if (short && !HEADING_TAGS.has(tagOf(el))) {
    const list = el.closest?.('ul,ol,nav,div');
    if (list && isLinkList(list)) return true;
  }

  return false;
}

/** 译文的排版角色：决定字号层级，与字体差异化是两条正交的规则 */
function roleOf(el, text, opts) {
  if (HEADING_TAGS.has(tagOf(el))) return 'heading';
  if (text.length <= opts.uiTextMax && el.closest?.(UI_CONTAINERS)) return 'ui';
  return 'body';
}

function makeUnit({ el, anchor, mode, text, opts }) {
  const role = roleOf(el, text, opts);
  let srcSize = 0;
  if (role === 'heading' && typeof getComputedStyle === 'function') {
    srcSize = parseFloat(getComputedStyle(el).fontSize) || 0;
  }
  return {
    id: nextId++,
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
function reuseOrSkip(unit) {
  const existing = translationFor(unit);
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
  if (KEEP_INLINE.has(tag)) return 'keep';
  if (DROP_INLINE.has(tag)) return 'drop';
  if (CUT_BLOCK.has(tag)) return 'cut';
  if (isSkippedElement(node, opts)) return isInline(node) ? 'drop' : 'cut';
  return isInline(node) ? 'keep' : 'block';
}

/** run = 连续的行内内容。counted 的才进正文，drop 的只是不打断句子。 */
function pieceText({ node, counted }) {
  if (!counted) return '';
  // <br> 是显式换行，textContent 为空 —— 直接拼接会把两侧的句子粘死，补一个空格
  if (node.nodeType === Node.ELEMENT_NODE && tagOf(node) === 'BR') return ' ';
  return node.textContent || '';
}

function runText(run) {
  return normalize(run.map(pieceText).join(''));
}

function collectRun(run, el, out, opts, stray) {
  if (!run.length) return;
  const text = runText(run);
  if (!isTranslatable(text, opts, el)) return;
  if (layoutRejects(el, text, opts)) return;
  const unit = reuseOrSkip(
    makeUnit({ el, anchor: run[run.length - 1].node, mode: 'after', text, opts })
  );
  if (!unit) return;
  // run 中间夹着旧译文（原文后面又被追加了内容）：复用它，避免留下孤儿节点
  if (!unit.node && stray && stray.isConnected) unit.node = stray;
  out.push(unit);
}

/** 叶子块的正文同样要排除 drop 掉的行内内容，不能直接用 textContent */
function leafText(el, opts) {
  const run = [];
  for (const node of el.childNodes) {
    const role = childRole(node, opts);
    if (role === 'own') continue;
    run.push({ node, counted: role === 'keep' });
  }
  return runText(run);
}

function walk(el, out, opts) {
  if (isSkippedElement(el, opts)) return;

  let run = [];
  let stray = null; // run 中间遇到的旧译文节点
  let sawBlockChild = false;

  for (const node of el.childNodes) {
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
    const text = leafText(el, opts);
    if (!isTranslatable(text, opts, el)) return;
    if (layoutRejects(el, text, opts)) return;
    const mode = APPEND_INSIDE.has(tagOf(el)) ? 'append' : 'after';
    const unit = reuseOrSkip(makeUnit({ el, anchor: el, mode, text, opts }));
    if (unit) out.push(unit);
    return;
  }

  collectRun(run, el, out, opts, stray);
}

/**
 * 扫描 root 下所有待翻译单元。
 * 已翻译且未变化的内容会被自然跳过，所以可以对同一页面重复调用（动态内容就靠这个）。
 */
export function scan(root, config) {
  const opts = {
    minTextLength: config.minTextLength,
    // 界面上是一个开关，核心仍分三档：它们解决的是同一件事，
    // 但排查问题时需要能单独关掉某一档（比如无布局环境下的布局判断）。
    // 显式传了细粒度开关就以它为准，否则跟随 smartFilter。
    skipSameScript: config.skipSameScript ?? config.smartFilter !== false,
    skipSingleToken: config.skipSingleToken ?? config.smartFilter !== false,
    skipTightLayout: config.skipTightLayout ?? config.smartFilter !== false,
    skipSelectors: (config.skipSelectors || '').trim(),
    skipAside: config.contentRootOnly !== false,
    uiTextMax: LIMITS.UI_TEXT_MAX_CHARS,
    targetScript: targetScript(config.targetLang)
  };
  const out = [];
  let start = root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;
  if (!start) return out;

  // 正文优先：先把范围收到正文根，语义与布局规则只作为根内的二次过滤。
  // 之前没有这一步，"正文优先"只是个名字。
  if (config.contentRootOnly !== false && (start === document.body || start === document.documentElement)) {
    const detected = findContentRoot(document);
    if (detected) start = detected;
  }
  try {
    walk(start, out, opts);
  } catch (e) {
    console.warn('[BYOM] 扫描中断', e);
  }
  return out;
}

/** 页面语境：给 prompt 和本地分类器用，不含正文，成本可忽略 */
export function collectPageContext() {
  const meta = (name) =>
    document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content || '';
  const headings = [...document.querySelectorAll('h1, h2')]
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
