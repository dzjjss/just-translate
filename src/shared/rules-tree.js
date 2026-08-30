import { normalizeRules } from './rules-yaml.js';

/**
 * 规则的树形只读视图。
 *
 * 和纯文本框是双态关系：树形负责"一眼看清判成了什么"，文本框负责改。
 * 不做结构化编辑器 —— 那要贵一个量级，而两个诉求分开各自最优。
 *
 * 每一项带来源标记，这样"某个词为什么被这么翻"是可回答的：
 *   auto  预检画像自动判定
 *   user  你自己写的规则
 */

const SOURCE_LABEL = { auto: '自动', user: '规则' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function tag(text, source) {
  return `<span class="rt-tag" data-src="${source || 'auto'}">${esc(text)}</span>`;
}

function pairRows(map, sources, kind) {
  return Object.entries(map)
    .map(([k, v]) => {
      const src = sources?.[kind]?.[k] || 'auto';
      return `<div class="rt-row" data-src="${src}">
        <code class="rt-k">${esc(k)}</code>
        <span class="rt-arrow">→</span>
        <span class="rt-v">${esc(v)}</span>
        <span class="rt-src" title="来源">${SOURCE_LABEL[src] || src}</span>
      </div>`;
    })
    .join('');
}

/**
 * 生成树形 HTML。sources 可选，形如 { hard: {term: 'user'}, risky: {...} }。
 * 返回字符串而不是节点：调用方只在自己的面板里用，字符串更好测也更好拼。
 */
export function renderRulesTree(rules, sources) {
  const r = normalizeRules(rules);
  const blocks = [];

  if (r.principle) {
    // 单独一档且排在最前：它是祈使句，作用力比下面几档的词条映射更大
    blocks.push(`<section class="rt-sec rt-principle">
      <h4>本页原则 <em>压过通用领域指导</em></h4>
      <p class="rt-principle-text" data-src="${sources?.principle || 'auto'}">${esc(r.principle)}</p>
    </section>`);
  }

  if (r.domain.length) {
    blocks.push(`<section class="rt-sec rt-domain">
      <h4>领域</h4>
      <div class="rt-tags">${r.domain.map((d) => tag(d, sources?.domain?.[d])).join('')}</div>
      <p class="rt-note">领域义永远压过日常义</p>
    </section>`);
  }

  if (Object.keys(r.hard).length) {
    blocks.push(`<section class="rt-sec rt-hard">
      <h4>锁定 <em>不许因语句流畅度而改</em></h4>
      ${pairRows(r.hard, sources, 'hard')}
    </section>`);
  }

  if (Object.keys(r.preferred).length) {
    blocks.push(`<section class="rt-sec rt-preferred">
      <h4>优先 <em>倾向，允许语境覆盖</em></h4>
      ${pairRows(r.preferred, sources, 'preferred')}
    </section>`);
  }

  const risky = Object.entries(r.risky);
  if (risky.length) {
    // 语义与上两档相反：给义项、不给译法，所以视觉上必须区分开
    const rows = risky
      .map(([w, sense]) => {
        const src = sources?.risky?.[w] || 'auto';
        return `<div class="rt-risk" data-src="${src}">
          <code class="rt-k">${esc(w)}</code>
          <span class="rt-sense">${sense ? esc(sense) : '未注明义项，按句判断'}</span>
          <span class="rt-src">${SOURCE_LABEL[src] || src}</span>
        </div>`;
      })
      .join('');
    blocks.push(`<section class="rt-sec rt-risky">
      <h4>风险词 <em>给义项，不给译法</em></h4>
      ${rows}
    </section>`);
  }

  if (r.keep.length) {
    blocks.push(`<section class="rt-sec rt-keep">
      <h4>不翻</h4>
      <div class="rt-tags">${r.keep.map((k) => tag(k, sources?.keep?.[k])).join('')}</div>
    </section>`);
  }

  if (!blocks.length) return '<p class="rt-empty">当前没有额外翻译约束。普通页面通常不需要；翻译时仍会自动读取整页语境。</p>';
  return blocks.join('');
}

/** 标出每一项来自哪里：用户写的 > 预检自动 */
export function buildSources({ auto, user }) {
  const out = { principle: '', domain: {}, hard: {}, preferred: {}, risky: {}, keep: {} };
  const mark = (rules, label) => {
    const n = normalizeRules(rules);
    if (n.principle) out.principle = label;
    for (const d of n.domain) out.domain[d] = label;
    for (const k of Object.keys(n.hard)) out.hard[k] = label;
    for (const k of Object.keys(n.preferred)) out.preferred[k] = label;
    for (const k of Object.keys(n.risky)) out.risky[k] = label;
    for (const k of n.keep) out.keep[k] = label;
  };
  mark(auto, 'auto');
  mark(user, 'user'); // 最后覆盖：用户写的优先级最高
  return out;
}
