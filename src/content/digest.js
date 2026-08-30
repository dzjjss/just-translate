/**
 * 把当前 PageSession 的 units 拼成一份纯文本摘要，给翻译预检和导出用。
 * 不碰 DOM、不含 HTML：只保留 # 层级和 - 列表两种标记 ——
 * 标题被当正文翻，多半就是因为层级信息在扁平文本里丢了。
 */

const H_LEVEL = { H1: 1, H2: 2, H3: 3, H4: 3, H5: 3, H6: 3 };
const URL_RE = /https?:\/\/\S+/g;

function lineOf(unit) {
  const text = unit.text.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim();
  if (!text) return null;
  if (unit.role === 'heading') {
    const level = H_LEVEL[unit.tag] || 3;
    return { kind: 'h', level, text: '#'.repeat(level) + ' ' + text };
  }
  if (unit.mode === 'append' && (unit.tag === 'LI' || unit.tag === 'DT' || unit.tag === 'DD')) {
    return { kind: 'li', text: '- ' + text };
  }
  return { kind: 'p', text };
}

/**
 * budget 超限时按结构采样而不是截断：标题全留、每节正文留前 2 段、列表留前 3 条。
 * 截断会让文档后半段完全不可见，而 stuttering 那类问题恰恰在最后的故障排除章节。
 */
export function buildPlainDigest(units, { budget = 12000 } = {}) {
  budget = Math.max(0, Number(budget) || 0);
  const seen = new Set();
  const lines = [];
  let total = 0;

  for (const unit of units) {
    const line = lineOf(unit);
    if (!line || seen.has(line.text)) continue;
    seen.add(line.text);
    if (lines.length) total += 1; // 实际 join('\n') 的换行
    lines.push(line);
    total += line.text.length;
  }

  if (total <= budget) {
    return { text: lines.map((l) => l.text).join('\n'), chars: total, sampled: false, kept: lines.length, total: lines.length };
  }

  const out = [];
  let p = 0;
  let li = 0;
  let chars = 0;

  // 真正的硬预算：哪怕单个超长标题/段落本身就超过 budget，也不能越界。
  // 最后一行允许截断；否则“结构采样”仍可能被一个 8 万字符的 DOM 节点击穿。
  const pushWithinBudget = (text) => {
    const separator = out.length ? 1 : 0;
    const remaining = budget - chars - separator;
    if (remaining <= 0) return false;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    if (!clipped) return false;
    out.push(clipped);
    chars += separator + clipped.length;
    return clipped.length === text.length;
  };

  for (const line of lines) {
    if (chars >= budget) break;
    if (line.kind === 'h') {
      p = 0;
      li = 0;
      if (!pushWithinBudget(line.text)) break;
      continue;
    }
    if (line.kind === 'li' && li >= 3) continue;
    if (line.kind === 'p' && p >= 2) continue;
    if (line.kind === 'li') li++;
    else p++;
    if (!pushWithinBudget(line.text)) break;
  }
  return { text: out.join('\n'), chars, sampled: true, kept: out.length, total: lines.length };
}

/** 双语对照 Markdown 导出：仅含已完成的单元 */
export function buildBilingualMarkdown(units) {
  const out = [];
  for (const unit of units) {
    if (unit.state !== 'done' || !unit.node?.isConnected) continue;
    const t = unit.node.textContent.trim();
    if (unit.role === 'heading') {
      const level = '#'.repeat(H_LEVEL[unit.tag] || 3);
      out.push(`${level} ${unit.text}`, `**${t}**`, '');
    } else if (unit.mode === 'append' && unit.tag === 'LI') {
      out.push(`- ${unit.text}`, `  ${t}`, '');
    } else {
      out.push(unit.text, '', t, '');
    }
  }
  return out.join('\n');
}
