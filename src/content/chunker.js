import { LIMITS } from '../shared/constants.js';

/**
 * 分批策略：字符预算优先，条数封顶。
 * 批越大越省 token，但对齐失败的代价也越大（一次要重来一整批），
 * 而且首屏译文出现得越晚。2800 字符 / 20 条是延迟和成本之间比较稳的点。
 */
export function buildChunks(units, { maxChars = 2800, maxItems = LIMITS.MAX_ITEMS_PER_CHUNK } = {}) {
  const chunks = [];
  let cur = [];
  let chars = 0;

  for (const unit of units) {
    // 标题强制开新批：切分对齐结构边界，模型拿到的是完整语义块而不是随机窗口。
    // token 成本不变，这是免费的。
    if (unit.role === 'heading' && cur.length) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    const len = unit.text.length;
    // 单条就超预算：自己独占一批，不切碎句子
    if (len >= maxChars) {
      if (cur.length) {
        chunks.push(cur);
        cur = [];
        chars = 0;
      }
      chunks.push([unit]);
      continue;
    }
    if (cur.length >= maxItems || chars + len > maxChars) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(unit);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
