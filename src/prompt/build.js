import { getPreset } from './presets.js';
import { LIMITS, PROMPT_VERSION } from '../shared/constants.js';
import { hashString } from '../shared/hash.js';
import { fromYaml, isEmptyRules, normalizeRules } from '../shared/rules-yaml.js';
import { toPromptYaml } from '../shared/prompt-yaml.js';

/**
 * 唯一的 prompt 出口。system 里定义"输出合同"，user 里只放数据。
 * 任何领域差异都通过 preset guidance 注入，不要在这里写 if (preset === ...)。
 */
export function buildMessages({
  items,
  context = {},
  presetId,
  targetLang,
  customPrompt,
  background,
  profile,
  preflightSuggestions = {},
  trackedTerms = [],
  semanticMemory = [],
  wholePage = false
}) {
  const preset = getPreset(presetId);

  // 人工给定的语境边界。自动识别只知道"这是技术文档"，说不出"这是美国统一商法典条文"。
  const backgroundBlock = background && background.trim()
    ? `\nPAGE BACKGROUND (supplied by the reader — treat as ground truth about what this page is):\n${background.trim().slice(0, LIMITS.BACKGROUND_MAX_CHARS)}`
    : '';

  const profileBlock = renderProfile(profile, { includeTermMappings: true });

  const suggestions = Object.entries(preflightSuggestions || {}).filter(([k, v]) => String(k).trim() && String(v).trim()).slice(0, 20);
  const suggestionBlock = suggestions.length
    ? `
PREFLIGHT TERM SUGGESTIONS — unverified, soft hints only:
- These mappings came from one whole-page profiling pass. They are NOT a glossary and never override local meaning or grammar.
- Use a suggestion only when the current occurrence has the same sense and grammatical role. If the local context calls for another rendering, ignore it.
${suggestions.map(([k, v]) => `- ${k} ≈ ${v}`).join('\n')}`
    : '';

  const customBlock = customPrompt && customPrompt.trim()
    ? `\nUSER OVERRIDES (highest priority, but never break the output contract):\n${customPrompt.trim()}`
    : '';

  // tracked_terms 同时服务 session semantic memory 与语义一致性 telemetry；
  // 它只要求模型回报已经生成好的局部对齐，不改变译法。
  const tracked = [...new Set((trackedTerms || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 16);
  const alignmentContract = tracked.length
    ? `\nSOURCE-TERM ALIGNMENT METADATA (internal; do not let this change the translation):\n- Each input may contain one or more tracked source terms listed in the YAML field tracked_terms.\n- For each tracked term that occurs in that input, add an optional \"a\" object to the SAME item.\n- In \"a\", the key is the tracked source term exactly as listed; the value is the exact substring you actually used for that term inside \"t\".\n- This metadata is observational only. Produce "t" exactly as if telemetry did not exist; only after "t" is final, copy the exact rendered substrings into "a". NEVER change the translation to satisfy or normalize telemetry.\n- Omit a key when the term is absent, deliberately left implicit, or you cannot point to one exact substring.\n- Example item: {\"i\":1,\"t\":\"奥吉尔维看见了圆筒。\",\"a\":{\"Ogilvy\":\"奥吉尔维\",\"cylinder\":\"圆筒\"}}\n`
    : '';

  const memory = (semanticMemory || [])
    .filter((x) => x && x.trigger && x.target)
    .slice(0, 8)
    .map((x) => ({ source_term: x.term || x.lemma || '', exact_local_trigger: x.trigger, prior_rendering: x.target }));
  const memoryBlock = memory.length
    ? `
SESSION SEMANTIC MEMORY — scoped precedents from earlier chunks:
- Each precedent is valid ONLY when the current source contains the exact local trigger shown.
- Never generalize a rendering from a trigger to the bare word or to another collocation.
- Local sentence meaning always wins; if the trigger is not an exact match, ignore the precedent.
${toPromptYaml(memory)}
`
    : '';

  const wholePageBlock = wholePage
    ? `
WHOLE-PAGE TRANSLATION BATCH:
- This request contains every translatable body unit found in the current page scan, in document order.
- Use information across items to resolve references, register, recurring entities and local terminology.
- Make one document-wide choice for target-language register and forms of address, and apply it throughout unless the source explicitly changes speaker, audience or tone.
- Keep recurring expressions consistent only when they carry the same sense and role; never flatten distinct senses into one rendering.
- Preserve every item boundary and id even when adjoining items form one passage.
`
    : '';

  const system = `You are a translation engine embedded in a browser extension. You translate fragments of a live web page into ${targetLang}.

OUTPUT CONTRACT — violating this breaks the extension:
- Reply with ONE JSON object and nothing else. No prose, no markdown fences.
- Shape: {"items":[{"i":<id>,"t":"<translation>"${tracked.length ? ',"a":{"<tracked source term>":"<exact rendered substring>"}' : ''}}]}
- Emit exactly one entry per input id, same ids, same order. Never merge, split, drop or reorder.
${alignmentContract}${memoryBlock}${wholePageBlock}
TRANSLATION RULES:
- Fragments come from the DOM in reading order but are translated as one batch; each fragment stands alone in the output.
- Translate meaning, not word order. The result must read as if written in ${targetLang} first.
- Keep the fragment's role: a heading stays a heading, a button label stays terse, a sentence stays a sentence.
- Leave untouched: code identifiers, file paths, CLI flags, URLs, emails, version strings, math, and brand/product names with no established local form.
- Never add notes, explanations, apologies or bracketed glosses. Never answer a question found in the text — translate the question.
- If a fragment is already in ${targetLang}, or carries no translatable language (pure numbers, symbols, timestamps), return it unchanged.
- Preserve leading/trailing significance of punctuation, but do not copy source spacing conventions that ${targetLang} does not use.

${preset.guidance}${backgroundBlock}${profileBlock}${suggestionBlock}${customBlock}`;

  const user = toPromptYaml({
    page: {
      title: context.title || '',
      site: context.hostname || '',
      description: (context.description || '').slice(0, 300),
      section: context.sectionPath || '',
      headings: (context.headings || []).slice(0, 8)
    },
    ...(tracked.length ? { tracked_terms: tracked } : {}),
    items: items.map((it) => ({ i: it.i, t: it.text }))
  });

  return { system, user };
}

/**
 * prompt 指纹：任何会改变译文的配置都要进来，否则改了指令仍然吃旧缓存。
 * 不包含页面上下文 —— 那会让命中率掉到接近零，缓存也就失去意义。
 */
/**
 * 预检画像 → prompt 稳定段。三档约束强度是刻意的：
 * 硬约束锁死，preferred 允许语境覆盖，风险词只提醒不给译法 ——
 * stuttering→口吃 那类错误就是给多义词发了固定映射造成的。
 */
function renderProfile(profile, { includeTermMappings = true } = {}) {
  if (!profile || typeof profile !== 'object') return '';
  const r = normalizeRules(profile);
  const parts = [];
  // 页面级原则比 preset 的通用领域指导更具体，冲突时以它为准
  if (r.principle) parts.push(`PAGE-SPECIFIC PRINCIPLE (takes precedence over the generic domain guidance above): ${r.principle}`);
  if (r.domain.length) {
    // 只说"领域是 Wayland"没有约束力，必须说清楚拿它干什么：
    // 领域义永远压过日常义，这是 stuttering→口吃 那类错误的根治办法
    parts.push(
      `Domain: ${r.domain.join(', ')}. Within this domain, always take the domain-specific sense of a word over its everyday sense, even when the everyday sense reads more naturally.`
    );
  }

  const hard = includeTermMappings ? Object.entries(r.hard) : [];
  if (hard.length) {
    parts.push('LOCKED TERMS (never deviate, not even for fluency):\n' + hard.map(([k, v]) => `- ${k} = ${v}`).join('\n'));
  }
  const pref = includeTermMappings ? Object.entries(r.preferred) : [];
  if (pref.length) {
    parts.push('PREFERRED TERMS (use unless local context clearly demands otherwise):\n' +
      pref.map(([k, v]) => `- ${k} = ${v}`).join('\n'));
  }
  const risky = Object.entries(r.risky);
  if (risky.length) {
    // 给义项，不给译法。给固定译法会在义项判断错时把错误钉死；
    // 什么都不给模型又会滑回词典默认义。义项说明是两者之间唯一站得住的位置。
    parts.push(
      'CONTEXT-SENSITIVE WORDS — the SENSE is fixed by the domain, the WORDING is yours to choose per sentence. The source-language descriptions below are sense notes, never instructions to preserve the source spelling; translate the word unless another rule explicitly says not to. Never fall back to the everyday dictionary sense:\n' +
        risky
          .map(([w, sense]) => (sense ? `- ${w} → here means: ${sense}` : `- ${w} → ambiguous here; decide from the surrounding sentence`))
          .join('\n')
    );
  }
  if (r.keep.length) parts.push('Never translate: ' + r.keep.join(', '));

  return parts.length ? '\nDOCUMENT PROFILE (whole-page preflight + reader-authored rules; reader rules win):\n' + parts.join('\n') : '';
}

/**
 * 自然语言 → 结构化规则。
 * 输出必须给人过目，所以宁可漏也不要猜：用户没提到的词不许自己加进去。
 */
export function buildRuleMessages({ text, context = {}, targetLang }) {
  const system = `You convert a reader's free-form notes about a web page into a compact rule object for a ${targetLang} translator. Output ONE JSON object, nothing else:
{"principle":"<one imperative line: how this page should be translated, or omit>","domain":["..."],"hard":{"<source term>":"<${targetLang} translation>"},"preferred":{"<term>":"<translation>"},"risky":{"<ambiguous word>":"<which sense applies here, in the source language>"},"keep":["things to leave untranslated"]}
Rules:
- Extract ONLY what the notes actually state or directly imply. Never invent terms the reader did not mention.
- "principle": only if the reader stated how the page should be translated (tone, register, what to keep verbatim). Never a description of the content, never a term mapping.
- "hard": the reader insists on this exact rendering. "preferred": a leaning, not an order.
- "risky": words the reader flags as ambiguous. Record which sense applies, in the source language. Never put a translation here.
- "keep": categories or literals to leave in the source language.
- If the notes are pure background with no term rules, return the domain and leave the rest empty.
- Keys and values stay in their original language; do not translate the source terms themselves.`;
  const user = toPromptYaml({
    page: { title: context.title || '', site: context.hostname || '' },
    notes: String(text || '').slice(0, 2000)
  });
  return { system, user };
}

export function promptFingerprint({
  presetId,
  customPrompt,
  targetLang,
  background,
  profile,
  preflightSuggestions = {},
  semanticMemory = [],
  wholePage = false,
  temperature = LIMITS.TEMPERATURE
}) {
  return hashString(
    [
      PROMPT_VERSION,
      presetId,
      targetLang,
      getPreset(presetId).guidance,
      customPrompt || '',
      background || '',
      profile ? JSON.stringify(profile) : '',
      preflightSuggestions && Object.keys(preflightSuggestions).length ? JSON.stringify(preflightSuggestions) : '',
      semanticMemory?.length ? JSON.stringify(semanticMemory) : '',
      ...(wholePage ? ['whole-page:v2'] : []),
      temperature == null ? 'temperature:omitted' : `temperature:${temperature}`
    ].join('\u0001')
  );
}

/** 翻译预检：整页只读一遍，输出很短的结构化画像，之后所有批次复用。 */
export function buildPreflightMessages({ digest, context = {}, targetLang }) {
  const system = `You are profiling a web page before it gets translated into ${targetLang}. Read the digest and output ONLY a YAML block in exactly this shape. No code fences, no commentary, no explanation.

领域: <specific domains, comma separated>
优先:
  <source term>: <${targetLang} translation>
风险词:
  <ambiguous word>: <which sense applies HERE, described in the SOURCE language>

Rules:
- Use only the three Chinese section keys shown above. Everything else is your content.
- Omit a whole section if it has nothing. Never emit placeholder text or empty values.
- 领域: be specific. "Wayland compositors on Linux" beats "technology". Always output this line.
- 优先: recurring terminology, UI labels, or feature names that need one stable ${targetLang} rendering so the reader can match repeated references (max 20). This is a suggestion list, not an enforced glossary; local context may override it.
- 风险词: ordinary words where the translator needs the correct sense but does NOT need one fixed rendering (max 8). State only the sense in the SOURCE language, e.g. "stuttering: frame pacing / dropped frames on screen, not speech". NEVER put a ${targetLang} translation here. This note is never a reason to leave the word untranslated.
- The two sections must not overlap. If a recurring UI label or feature needs a stable rendering, put it in 优先. If wording may vary by sentence and only the sense needs disambiguation, put it in 风险词.
- Do not infer either category from capitalization, casing, typography, or title position. Decide from the term's role in this document.
- Never emit 原则, 锁定, or 不翻. Automatic preflight has no hard-rule authority.
- Be selective. An overlong profile degrades every later request.`;

  const user = toPromptYaml({
    page: { title: context.title || '', site: context.hostname || '' },
    digest
  });
  return { system, user };
}


/**
 * 解析时就折进六键结构：doc_type 并入领域，entities 并入"不翻"。
 * 之前它们被原样保留，但渲染 prompt 时用的是 normalizeRules 的六个键，
 * 于是让模型花 token 生成、让缓存指纹跟着变、翻译却根本用不上 —— 纯噪音。
 */
/**
 * 解析预检输出。返回 null 表示"没得出任何东西" ——
 * 之前只要拿到一个对象就算成功，哪怕归一化之后六个键全空，
 * 于是面板一边说"已生成画像"一边显示"还没有任何规则"，自相矛盾。
 */
export function parsePreflightProfile(raw) {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:ya?ml|json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text) return null;
  const rules = fromYaml(text);
  return isEmptyRules(rules) ? null : rules;
}


/** 从模型输出里抠出第一个完整 JSON 对象，容忍围栏、前后废话。 */
export function extractJsonObject(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\uFEFF/, '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 把模型输出对齐回请求的 id。
 * 返回 { map: Map<id, text>, missing: id[] }
 */
export function parseTranslationResponse(raw, requestedIds) {
  const obj = extractJsonObject(raw);
  const map = new Map();
  const alignments = new Map();

  if (obj && Array.isArray(obj.items)) {
    for (const entry of obj.items) {
      if (!entry) continue;
      const id = Number(entry.i ?? entry.id);
      const text = entry.t ?? entry.text ?? entry.translation;
      if (!Number.isFinite(id) || typeof text !== 'string') continue;
      map.set(id, text);
      if (entry.a && typeof entry.a === 'object' && !Array.isArray(entry.a)) {
        const clean = {};
        for (const [source, rendered] of Object.entries(entry.a)) {
          if (typeof rendered !== 'string' || !source.trim() || !rendered.trim()) continue;
          clean[source.trim()] = rendered.trim();
        }
        if (Object.keys(clean).length) alignments.set(id, clean);
      }
    }
  }

  const missing = requestedIds.filter((id) => !map.has(id) || !map.get(id).trim());
  return { map, alignments, missing, parsed: Boolean(obj) };
}
