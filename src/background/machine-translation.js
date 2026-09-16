import { hashString } from '../shared/hash.js';
import { isUsableTranslation } from '../shared/translation-result.js';
import { toPlainError } from '../shared/logger.js';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function batchNonce(items, context = '') {
  return hashString(JSON.stringify({ items: items.map((item) => [item.i, item.text]), context })).replace(/-/g, '_');
}

function prefixFor(nonce) {
  return `__JT_${nonce}_`;
}

/**
 * 把多段正文合成一次机器翻译请求。标记只负责 ID 回填，不携带大小写或词义判断。
 * context 位于单独区间，译回后会被丢弃。
 */
export function packMachineBatch(items, { context = '', nonce = batchNonce(items, context) } = {}) {
  const prefix = prefixFor(nonce);
  const parts = [];
  if (String(context || '').trim()) {
    parts.push(`${prefix}CONTEXT__\n${String(context).trim()}\n${prefix}CONTEXT_END__`);
  }
  items.forEach((item, index) => {
    parts.push(`${prefix}UNIT_${index}__\n${String(item?.text || '')}`);
  });
  parts.push(`${prefix}END__`);
  return { text: parts.join('\n'), nonce, prefix };
}

/** 精确恢复单元边界；任一标记缺失会交给调用方做递归降级。 */
export function parseMachineBatch(output, items, nonce) {
  const text = String(output || '');
  const prefix = prefixFor(nonce);
  const marker = new RegExp(`${escapeRegExp(prefix)}UNIT_(\\d+)__`, 'g');
  const hits = [];
  let match;
  while ((match = marker.exec(text))) {
    hits.push({ index: Number(match[1]), start: match.index, contentStart: marker.lastIndex });
  }

  const endMarker = text.indexOf(`${prefix}END__`, hits.at(-1)?.contentStart || 0);
  const intact =
    hits.length === items.length &&
    hits.every((hit, index) => hit.index === index) &&
    endMarker >= 0;
  if (!intact) return { map: new Map(), missing: [...items], parsed: false };

  const seen = new Set();
  const map = new Map();
  for (let pos = 0; pos < hits.length; pos++) {
    const hit = hits[pos];
    if (!Number.isInteger(hit.index) || hit.index < 0 || hit.index >= items.length || seen.has(hit.index)) continue;
    seen.add(hit.index);
    const next = hits[pos + 1]?.start ?? text.indexOf(`${prefix}END__`, hit.contentStart);
    const end = next >= 0 ? next : text.length;
    const translated = text.slice(hit.contentStart, end).trim();
    if (translated) map.set(items[hit.index].i, translated);
  }
  const missing = items.filter((item) => !map.has(item.i));
  return { map, missing, parsed: map.size > 0 };
}

/**
 * 边界标记被服务端改写时，整批作废：先二分，最后一项退回裸文本请求。
 * 少一个标记就可能让前一段吞进后一段，部分结果也不能信。
 */
export async function translateMachineWithRecovery({
  items, context = '', request, runtime = null, targetLang = ''
}) {
  const source = Array.isArray(items) ? items : [];
  const pending = source.length ? [{ items: source, depth: 0 }] : [];
  const accepted = new Map();
  let error = null;
  while (pending.length) {
    const batch = pending.pop();
    try {
      const result = await translateMachineBatch(batch, context, request, targetLang);
      if (result) {
        for (const item of result) accepted.set(item.i, item);
      } else if (batch.items.length > 1) {
        if (runtime) runtime.boundaryRecoveryCount++;
        const mid = Math.ceil(batch.items.length / 2);
        pending.push({ items: batch.items.slice(mid), depth: batch.depth + 1 });
        pending.push({ items: batch.items.slice(0, mid), depth: batch.depth + 1 });
      } else if (batch.depth === 0 && context) {
        pending.push({ items: batch.items, depth: 1 });
      }
    } catch (failure) {
      error = toPlainError(failure);
      break;
    }
  }
  return { items: [...accepted.values()], failed: source.filter(item => !accepted.has(item.i)).map(item => item.i), error };
}

async function translateMachineBatch(batch, context, request, targetLang) {
  const { items, depth } = batch;
  if (items.length === 1 && (!context || depth > 0)) {
    const text = String(await request(items[0].text, depth)).trim();
    return isUsableTranslation(items[0].text, text, targetLang)
      ? [{ i: items[0].i, t: text, source: items[0].text }] : null;
  }
  const packed = packMachineBatch(items, { context });
  let output;
  try {
    output = await request(packed.text, depth);
  } catch (error) {
    if ([413, 414].includes(Number(error.status))) return null;
    throw error;
  }
  const parsed = parseMachineBatch(output, items, packed.nonce);
  if (parsed.missing.length) return null;
  if (items.some(item => !isUsableTranslation(item.text, parsed.map.get(item.i), targetLang))) return null;
  return items.map(item => ({ i: item.i, t: parsed.map.get(item.i), source: item.text }));
}
