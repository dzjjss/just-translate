/**
 * 规则的人类可读形式。
 *
 * 用户用自然语言写「这是 UCC 条文，article 译作编，bailee 用受托保管人」，
 * 模型把它转成这里定义的结构；转完必须显示出来让人改 —— 转换器本身也是模型调用，
 * 会读错、会漏、会自作主张，不给人过目就等于把错误固化进每一次请求。
 *
 * 刻意手写一个极小的 YAML 子集而不是引依赖：结构是固定的六个键，
 * 而且要能容忍模型偶尔写成英文键名或者 JSON。
 */

const KEY_ALIASES = {
  // 摘要是旧键名，保留只为不丢用户已经存下的规则文本
  原则: 'principle', principle: 'principle', 摘要: 'principle', summary: 'principle',
  领域: 'domain', domain: 'domain',
  锁定: 'hard', hard: 'hard', locked: 'hard',
  优先: 'preferred', preferred: 'preferred',
  风险词: 'risky', risky: 'risky',
  不翻: 'keep', keep: 'keep', do_not_translate: 'keep'
};

const LABEL = {
  principle: '原则',
  domain: '领域',
  hard: '锁定',
  preferred: '优先',
  risky: '风险词',
  keep: '不翻'
};

/**
 * risky 从"一串裸词"升级成"词 → 义项说明"。
 * 只说这个词在本文里指什么（用原文语言描述），不给目标语言译法：
 * 给固定映射会重演 stuttering→口吃，什么都不给模型又会滑回词典默认义，
 * 义项说明是这两者之间唯一站得住的位置。
 */
export const EMPTY_RULES = { principle: '', domain: [], hard: {}, preferred: {}, risky: {}, keep: [] };

/**
 * 需要加引号的 key/value：含冒号、井号、引号或首尾空白。
 * 技术术语里冒号很常见（std::vector、HTTP: header），不加引号往返即损坏 ——
 * 之前的往返测试全用 article、bailee 这类安全 key，所以一直没暴露。
 */
function quoteIfNeeded(str) {
  const t = String(str);
  return /[:#'"]|^\s|\s$/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

function cleanList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,，、]/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

function cleanMap(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const key = String(k).trim();
    const value = String(val ?? '').trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** risky 允许写成裸列表（无义项）或映射（带义项），统一成映射 */
function cleanRisky(v) {
  const out = {};
  if (!v) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        const word = String(item.word || item.term || '').trim();
        if (word) out[word] = String(item.sense || item.meaning || '').trim();
      } else {
        const word = String(item ?? '').trim();
        if (word) out[word] = '';
      }
    }
    return out;
  }
  if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const word = String(k).trim();
      if (word) out[word] = String(val ?? '').trim();
    }
    return out;
  }
  for (const word of cleanList(v)) out[word] = '';
  return out;
}

export function normalizeRules(raw) {
  const r = raw || {};
  // 兼容预检画像的形状（terms.hard / terms.preferred / do_not_translate）
  const hard = r.hard ?? r.terms?.hard;
  const preferred = r.preferred ?? r.terms?.preferred;
  return {
    /**
     * 这一页该怎么翻，一句话。是祈使的，不是描述的 ——
     * "讲 Wayland 显示协议"对输出没有任何约束力，
     * "命令与参数原样保留，保持说明性语气不做润色"才有。
     * 只写通用领域指导覆盖不到的部分；没有特别之处就留空，别凑。
     */
    principle: String(r.principle ?? r.summary ?? '').trim().slice(0, 80),
    domain: cleanList(r.domain),
    hard: cleanMap(hard),
    preferred: cleanMap(preferred),
    risky: cleanRisky(r.risky),
    keep: cleanList(r.keep ?? r.do_not_translate)
  };
}

export function isEmptyRules(r) {
  const n = normalizeRules(r);
  return (
    !n.principle && !n.domain.length && !n.keep.length && !Object.keys(n.risky).length &&
    !Object.keys(n.hard).length && !Object.keys(n.preferred).length
  );
}

export function toYaml(raw) {
  const r = normalizeRules(raw);
  const lines = [];
  if (r.principle) lines.push(`${LABEL.principle}: ${r.principle}`);
  if (r.domain.length) lines.push(`${LABEL.domain}: ${r.domain.join(', ')}`);
  for (const tier of ['hard', 'preferred']) {
    const entries = Object.entries(r[tier]);
    if (!entries.length) continue;
    lines.push(`${LABEL[tier]}:`);
    for (const [k, v] of entries) lines.push(`  ${quoteIfNeeded(k)}: ${quoteIfNeeded(v)}`);
  }
  const risky = Object.entries(r.risky);
  if (risky.length) {
    // 有义项的分行写，纯词列表还是一行，保持人手写起来轻松
    if (risky.some(([, sense]) => sense)) {
      lines.push(`${LABEL.risky}:`);
      for (const [w, sense] of risky) {
        lines.push(`  ${quoteIfNeeded(w)}: ${quoteIfNeeded(sense || '（此处义项待补）')}`);
      }
    } else {
      lines.push(`${LABEL.risky}: ${risky.map(([w]) => w).join(', ')}`);
    }
  }
  if (r.keep.length) lines.push(`${LABEL.keep}: ${r.keep.join(', ')}`);
  return lines.join('\n');
}

/** 容忍模型直接吐 JSON，也容忍用户手改出来的松散缩进 */
export function fromYaml(text) {
  const src = String(text || '').trim();
  if (!src) return { ...EMPTY_RULES };

  if (src.startsWith('{')) {
    try {
      return normalizeRules(JSON.parse(src));
    } catch {
      /* 落到逐行解析 */
    }
  }

  const out = { principle: '', domain: [], hard: {}, preferred: {}, risky: {}, keep: [] };
  let section = null;

  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indented = /^\s{1,}/.test(line);
    // 引号包裹的 key 整段取出，避免 std::vector 这类在第一个冒号处被切碎
    const m =
      line.trim().match(/^"((?:[^"\\]|\\.)*)"\s*[:：]\s*(.*)$/) ||
      line.trim().match(/^["'`]?([^:：]+?)["'`]?\s*[:：]\s*(.*)$/);
    if (!m) {
      // 「- 某项」这样的列表写法
      const item = line.trim().replace(/^[-*]\s*/, '');
      if (!item) continue;
      if (section === 'risky') out.risky[item] = '';
      else if (section === 'domain' || section === 'keep') out[section].push(item);
      continue;
    }

    const key = m[1].trim().replace(/\\"/g, '"');
    const value = m[2].trim().replace(/^"((?:[^"\\]|\\.)*)"$/, '$1').replace(/\\"/g, '"').replace(/^['`]|['`]$/g, '');
    const mapped = KEY_ALIASES[key] || KEY_ALIASES[key.toLowerCase()];

    if (mapped && !indented) {
      section = mapped;
      if (value) {
        if (mapped === 'hard' || mapped === 'preferred') {
          // 「锁定: a=b, c=d」这种一行写法
          for (const pair of value.split(/[,，]/)) {
            const kv = pair.split(/[=＝]/);
            if (kv.length === 2 && kv[0].trim() && kv[1].trim()) out[mapped][kv[0].trim()] = kv[1].trim();
          }
        } else if (mapped === 'principle') {
          out.principle = value;
          section = null;
        } else if (mapped === 'risky') {
          for (const w of cleanList(value)) out.risky[w] = '';
        } else {
          out[mapped].push(...cleanList(value));
        }
        section = null;
      }
      continue;
    }

    if (section === 'hard' || section === 'preferred') {
      if (key && value) out[section][key] = value;
    } else if (section === 'risky') {
      if (key) out.risky[key] = value === '（此处义项待补）' ? '' : value;
    } else if (section) {
      out[section].push(...cleanList(`${key} ${value}`.trim()));
    }
  }
  return normalizeRules(out);
}


/**
 * 自动预检只保留 domain / preferred / risky 三条软通道。
 * principle / hard / keep 都会直接约束译文，且彼此没有一致性保证；即使旧模型或旧缓存
 * 仍返回这些键，进入翻译前也统一清空。用户规则不走这里，人工写下的约束保持原权限。
 */
export function softenAutoRules(raw) {
  const r = normalizeRules(raw);
  const preferred = { ...r.preferred, ...r.hard };
  const risky = new Set(Object.keys(r.risky).map((x) => x.toLowerCase()));
  for (const key of Object.keys(preferred)) {
    if (risky.has(key.toLowerCase())) delete preferred[key];
  }
  return { ...r, principle: '', hard: {}, preferred, keep: [] };
}

/**
 * 合并：用户写的永远压过模型预检出来的。
 * 用户把某个词放进锁定，它就不该再出现在风险词里 —— 两者语义冲突。
 */
export function mergeRules(auto, user) {
  const a = normalizeRules(auto);
  const u = normalizeRules(user);
  const hard = { ...a.hard, ...u.hard };
  const preferred = { ...a.preferred, ...u.preferred };
  for (const k of Object.keys(hard)) delete preferred[k];

  const decided = new Set([...Object.keys(hard), ...Object.keys(preferred)].map((x) => x.toLowerCase()));
  // 用户写的义项覆盖模型给的；已经定死译法的词从风险词里移除
  const risky = {};
  for (const [w, sense] of [...Object.entries(a.risky), ...Object.entries(u.risky)]) {
    if (decided.has(w.toLowerCase())) continue;
    risky[w] = sense || risky[w] || '';
  }

  return {
    principle: u.principle || a.principle,
    domain: [...new Set([...u.domain, ...a.domain])],
    hard,
    preferred,
    risky,
    keep: [...new Set([...a.keep, ...u.keep])]
  };
}
