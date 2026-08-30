/**
 * 译后一致性检查，纯本地零调用。
 * 契约只来自预检画像与用户规则的锁定项；缓存和模型响应都不参与术语状态。
 */
/**
 * 已知限制：中文没有词边界，"小部件工具包"包含"部件工具包"，
 * 这类加字变体会被子串检查放过。这里主要抓完全换译法的硬漂移。
 */
export function detectGlossaryDrift(units, contract) {
  const entries = Object.entries(contract || {}).filter(
    ([k, v]) => k.length >= 4 && v && k.toLowerCase() !== v.toLowerCase()
  );
  if (!entries.length) return [];

  const hits = [];
  for (const unit of units) {
    if (unit.state !== 'done' || !unit.node?.isConnected) continue;
    const src = unit.text.toLowerCase();
    const trans = unit.node.textContent;
    for (const [term, target] of entries) {
      if (!src.includes(term.toLowerCase())) continue;
      if (trans.includes(target)) continue;
      hits.push({ id: unit.id, term, target, text: unit.text.slice(0, 80) });
      break;
    }
  }
  return hits;
}
