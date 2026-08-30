const MAX_CONTEXT_CHARS = 1400;
const MAX_NEIGHBOR_CHARS = 360;

function clipped(value, max = MAX_NEIGHBOR_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 分块机器翻译没有 prompt 通道，只把标题、章节路径和相邻原文作为可丢弃的上下文前缀。
 * 不写翻译指令，也不把格式当成词义判据。
 */
export function buildMachineContext({ units, chunk, title = '', sectionPath = '', maxChars = MAX_CONTEXT_CHARS }) {
  const all = Array.isArray(units) ? units : [];
  const current = Array.isArray(chunk) ? chunk : [];
  if (!current.length) return '';
  const ids = new Set(current.map((unit) => unit.id));
  const positions = all
    .map((unit, index) => ids.has(unit.id) ? index : -1)
    .filter((index) => index >= 0);
  const first = positions.length ? Math.min(...positions) : -1;
  const last = positions.length ? Math.max(...positions) : -1;
  const before = first >= 0 ? all.slice(Math.max(0, first - 2), first) : [];
  const after = last >= 0 ? all.slice(last + 1, last + 3) : [];
  const lines = [];
  if (clipped(title)) lines.push(`Title: ${clipped(title)}`);
  if (clipped(sectionPath)) lines.push(`Section: ${clipped(sectionPath)}`);
  for (const unit of before) lines.push(`Before: ${clipped(unit.text)}`);
  for (const unit of after) lines.push(`After: ${clipped(unit.text)}`);
  return lines.join('\n').slice(0, Math.max(0, Number(maxChars) || MAX_CONTEXT_CHARS));
}

