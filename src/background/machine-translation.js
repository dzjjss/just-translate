import { hashString } from '../shared/hash.js';

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
  items,
  context = '',
  request,
  runtime = null,
  depth = 0
}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { items: [], failed: [] };

  if (list.length === 1 && (!context || depth > 0)) {
    const translated = String(await request(list[0].text, depth)).trim();
    return translated
      ? { items: [{ i: list[0].i, t: translated, source: list[0].text }], failed: [] }
      : { items: [], failed: [list[0].i] };
  }

  const packed = packMachineBatch(list, { context });
  let output;
  try {
    output = await request(packed.text, depth);
  } catch (error) {
    const tooLarge = [400, 413, 414].includes(Number(error?.status));
    if (!tooLarge) throw error;
    if (runtime) runtime.boundaryRecoveryCount++;
    if (list.length === 1) {
      return translateMachineWithRecovery({ items: list, context: '', request, runtime, depth: depth + 1 });
    }
    const mid = Math.ceil(list.length / 2);
    const out = [];
    const failed = [];
    for (const half of [list.slice(0, mid), list.slice(mid)]) {
      const sub = await translateMachineWithRecovery({ items: half, context, request, runtime, depth: depth + 1 });
      out.push(...sub.items);
      failed.push(...sub.failed);
    }
    return { items: out, failed };
  }
  const parsed = parseMachineBatch(output, list, packed.nonce);
  const out = [];
  for (const item of list) {
    const translated = parsed.map.get(item.i);
    if (translated) out.push({ i: item.i, t: translated, source: item.text });
  }
  if (!parsed.missing.length) return { items: out, failed: [] };

  if (runtime) runtime.boundaryRecoveryCount++;
  // 少一个标记就可能让前一段吞进后一段，不能保留所谓“部分成功”。
  const missing = list;
  out.length = 0;
  if (missing.length === 1) {
    const sub = await translateMachineWithRecovery({ items: missing, context: '', request, runtime, depth: depth + 1 });
    return { items: [...out, ...sub.items], failed: sub.failed };
  }

  const mid = Math.ceil(missing.length / 2);
  const failed = [];
  for (const half of [missing.slice(0, mid), missing.slice(mid)]) {
    const sub = await translateMachineWithRecovery({ items: half, context, request, runtime, depth: depth + 1 });
    out.push(...sub.items);
    failed.push(...sub.failed);
  }
  return { items: out, failed };
}
