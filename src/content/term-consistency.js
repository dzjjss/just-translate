/**
 * 语义一致性观测层。
 *
 * 这层只收集 occurrence / alignment / 变体关系，不直接修改译文。
 * 0.14.11 起只保留有可靠判据的语义结果：FIXED / STABLE / UNKNOWN。
 * - Title Case / ALL CAPS 不能单独授予 FIXED 权限；
 * - 标题里的章节号、全大写目录词归 STRUCTURAL，从术语漂移统计中排除；
 * - 目标侧引号/空白只做比较归一化，不改变真实渲染；
 * - 多个目标变体统一留在 UNKNOWN，不用局部词形或子串规则替代语义判断。
 */

const WORD_RE = /[A-Za-z][A-Za-z0-9'’_-]*/g;
const MIN_LEXICAL_LEN = 3;
const ROMAN_RE = /^(?=[MDCLXVI]+$)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'if', 'is', 'am', 'are', 'was', 'were',
  'be', 'been', 'being', 'do', 'does', 'did', 'done', 'not', 'no', 'yes', 'but', 'so', 'nor', 'yet', 'one', 'its', 'our',
  'you', 'your', 'yours', 'we', 'us', 'they', 'their', 'them', 'he', 'his', 'she', 'her', 'it', 'this', 'that', 'these',
  'those', 'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how', 'has', 'had', 'have', 'having', 'can',
  'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would', 'about', 'after', 'again', 'against', 'almost', 'along',
  'already', 'also', 'among', 'another', 'because', 'before', 'between', 'both', 'every', 'first', 'from', 'great', 'here',
  'into', 'itself', 'more', 'most', 'much', 'never', 'other', 'over', 'same', 'since', 'some', 'still', 'such', 'than', 'then',
  'there', 'thing', 'through', 'under', 'until', 'very', 'while', 'with', 'without', 'however', 'therefore', 'perhaps',
  'although', 'though'
]);

// 人称代词缩写仍然只是语法词。“you'll”不能因为带撇号就绕过 you / will 停用词，
// 更不能进入多义词候选。这里只判断闭合的形式结构，不拿大小写推断词义。
const PRONOUN_CONTRACTION_RE = /^(?:i|you|we|they|he|she|it)['’](?:m|re|ve|ll|d|s)$/i;

function isStopToken(token) {
  const value = String(token || '').trim();
  return STOP.has(value.toLowerCase()) || PRONOUN_CONTRACTION_RE.test(value);
}

const TAXONOMY = Object.freeze({
  FIXED: 'FIXED',
  STABLE: 'STABLE',
  STRUCTURAL: 'STRUCTURAL',
  COMPOSITIONAL: 'COMPOSITIONAL',
  CONTEXTUAL: 'CONTEXTUAL',
  POLYSEMOUS: 'POLYSEMOUS',
  STYLISTIC: 'STYLISTIC',
  UNKNOWN: 'UNKNOWN'
});

function textOf(unit) {
  return typeof unit === 'string' ? unit : String(unit?.text || '');
}

function lexicalKey(term) {
  return String(term || '').trim().toLowerCase();
}

function identityKey(term, kind = 'lexical') {
  const raw = String(term || '').trim();
  if (kind === 'fixed') return `fixed:${raw}`;
  if (kind === 'locked') return `locked:${raw.toLowerCase()}`;
  // lexical / suggested / structural 共用 lemma identity，避免 COMMON 与 common 被人为拆开。
  return `lexical:${raw.toLowerCase()}`;
}

function clip(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function contextAround(text, index, length, radius = 100) {
  const src = String(text || '');
  if (!Number.isFinite(index) || index < 0) return clip(src, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(src.length, index + length + radius);
  return clip(`${start > 0 ? '…' : ''}${src.slice(start, end)}${end < src.length ? '…' : ''}`, radius * 2 + 16);
}

/**
 * 格式只能提供“高置信 identifier”证据，不能把普通 ALL CAPS 单词直接变成 FIXED。
 * iPhone / iPadOS / Wi-Fi / H264 这种形态保留；LTE / HTTP / API 需要额外语境或规则确认。
 */
export function isHighConfidenceFixedForm(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  if (isStopToken(t)) return false;
  if (/[a-z][A-Z]/.test(t)) return true;             // iPhone, iPadOS, macOS
  if (/[a-z]-[A-Z]/.test(t)) return true;            // Wi-Fi
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(t)) return true; // H264, 5G
  return false;
}

function isAllCapsWord(token) {
  const t = String(token || '');
  return /^[A-Z]{2,}$/.test(t);
}

function looksLikeHeadingUnit(unit) {
  if (unit?.role === 'heading') return true;
  const text = textOf(unit).trim();
  if (!text || text.length > 140) return false;
  const words = text.match(/[A-Za-z]+/g) || [];
  if (!words.length || words.length > 18) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  // 只用于排除“疑似标题排版”，不授予任何语义身份。
  return upper / letters.length >= 0.9;
}

function isStructuralHeadingToken(token, unit) {
  if (!looksLikeHeadingUnit(unit)) return false;
  const t = String(token || '').trim();
  return Boolean(t && (isAllCapsWord(t) || ROMAN_RE.test(t)));
}

function rankKind(kind) {
  if (kind === 'locked') return 5;
  if (kind === 'fixed') return 4;
  if (kind === 'suggested') return 3;
  if (kind === 'lexical') return 2;
  return 1; // structural
}

function addOccurrence(map, surface, unitIndex, kind, unitRole = 'body') {
  surface = String(surface || '').trim();
  if (!surface) return;
  const normalizedKind = ['fixed', 'structural', 'suggested'].includes(kind) ? kind : 'lexical';
  const key = identityKey(surface, normalizedKind);
  let row = map.get(key);
  if (!row) {
    row = {
      term: surface,
      lemma: normalizedKind === 'fixed' ? surface : lexicalKey(surface),
      key,
      count: 0,
      unitSet: new Set(),
      kind: normalizedKind,
      surfaces: new Map(),
      roles: new Map()
    };
    map.set(key, row);
  }
  if (rankKind(normalizedKind) > rankKind(row.kind)) row.kind = normalizedKind;
  row.count++;
  row.unitSet.add(unitIndex);
  row.surfaces.set(surface, (row.surfaces.get(surface) || 0) + 1);
  row.roles.set(unitRole || 'body', (row.roles.get(unitRole || 'body') || 0) + 1);
}

function makeBoundaryRegex(term, caseSensitive = false) {
  const escaped = String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, caseSensitive ? '' : 'i');
}

export function findSourceTerm(text, term, { caseSensitive = false } = {}) {
  const src = String(text || '');
  const t = String(term || '');
  if (!t) return null;
  const match = makeBoundaryRegex(t, caseSensitive).exec(src);
  if (!match) return null;
  const prefixLength = match[1]?.length || 0;
  return { surface: match[2], index: match.index + prefixLength };
}

export function sourceContainsTerm(text, term, options = {}) {
  return Boolean(findSourceTerm(text, term, options));
}

/** 从源文单元抽取跨单元重复观察对象。 */
export function extractRepeatedSourceTerms(units, { minUnits = 2, maxTerms = 48 } = {}) {
  const rows = new Map();
  const list = (units || []).map((unit) => typeof unit === 'string' ? { text: unit, role: 'body' } : unit);

  list.forEach((unit, unitIndex) => {
    const text = textOf(unit);
    for (const match of text.matchAll(WORD_RE)) {
      const token = match[0];
      if (isStopToken(token)) continue;

      if (isHighConfidenceFixedForm(token)) {
        addOccurrence(rows, token, unitIndex, 'fixed', unit?.role);
        continue;
      }

      if (isStructuralHeadingToken(token, unit)) {
        addOccurrence(rows, token, unitIndex, 'structural', unit?.role);
        continue;
      }

      if (token.length >= MIN_LEXICAL_LEN) addOccurrence(rows, token, unitIndex, 'lexical', unit?.role);
    }
  });

  return [...rows.values()]
    .filter((row) => row.unitSet.size >= minUnits)
    .map((row) => ({
      term: row.term,
      lemma: row.lemma,
      count: row.count,
      units: row.unitSet.size,
      kind: row.kind,
      trust: row.kind === 'fixed' ? 'AUTO' : 'OBSERVED',
      surfaces: [...row.surfaces.entries()]
        .map(([surface, count]) => ({ surface, count }))
        .sort((a, b) => (b.count - a.count) || a.surface.localeCompare(b.surface)),
      roles: [...row.roles.entries()].map(([role, count]) => ({ role, count }))
    }))
    .sort((a, b) =>
      (rankKind(b.kind) - rankKind(a.kind)) ||
      (b.units - a.units) ||
      (b.count - a.count) ||
      (b.term.length - a.term.length) ||
      a.term.localeCompare(b.term)
    )
    .slice(0, Math.max(0, maxTerms));
}

/** 当前批只取真正命中的观察对象，避免把整页候选反复塞进 prompt。 */
export function matchTrackedTermRows(candidates, items, { maxTerms = 16 } = {}) {
  const texts = (items || []).map(textOf);
  const out = [];
  const seen = new Set();
  for (const row of candidates || []) {
    const baseTerm = String(row?.term || '').trim();
    if (!baseTerm) continue;
    const kind = row.kind || 'lexical';
    const collisionKey = lexicalKey(row.lemma || baseTerm);
    if (seen.has(collisionKey)) continue;

    let term = baseTerm;
    let matched = false;
    if (kind === 'fixed') {
      matched = texts.some((text) => sourceContainsTerm(text, term, { caseSensitive: true }));
    } else {
      const surfaceForms = (row.surfaces || []).map((x) => String(x?.surface || '')).filter(Boolean);
      outer: for (const text of texts) {
        for (const surface of surfaceForms) {
          if (sourceContainsTerm(text, surface, { caseSensitive: true })) {
            term = surface;
            matched = true;
            break outer;
          }
        }
      }
      if (!matched) matched = texts.some((text) => sourceContainsTerm(text, baseTerm, { caseSensitive: false }));
    }
    if (!matched) continue;

    out.push({
      term,
      lemma: row.lemma || (kind === 'fixed' ? baseTerm : lexicalKey(baseTerm)),
      kind,
      surfaces: Array.isArray(row.surfaces) ? row.surfaces : undefined,
      roles: Array.isArray(row.roles) ? row.roles : undefined,
      trust: row.trust || undefined
    });
    seen.add(collisionKey);
    if (out.length >= maxTerms) break;
  }
  return out;
}

export function matchTrackedTerms(candidates, items, options) {
  return matchTrackedTermRows(candidates, items, options).map((row) => row.term);
}

function normalizeAlignmentObject(alignments) {
  const map = new Map();
  if (!alignments || typeof alignments !== 'object' || Array.isArray(alignments)) return map;
  for (const [source, rendered] of Object.entries(alignments)) {
    if (typeof rendered !== 'string') continue;
    const s = source.trim();
    const t = rendered.trim();
    if (!s || !t) continue;
    map.set(s, { source: s, rendered: t });
  }
  return map;
}

const QUOTE_PAIRS = new Map([
  ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉']
]);

/** 只用于比较；真实渲染值永远保留。 */
export function normalizeRenderedForComparison(value) {
  let text = String(value || '').normalize('NFKC').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    const end = QUOTE_PAIRS.get(text[0]);
    if (end && text.endsWith(end)) {
      text = text.slice(1, -1).trim();
      changed = true;
    }
  }
  return text;
}

function classifyRow(row, variants) {
  const variantCount = variants.length;
  if (row.kind === 'structural') {
    return { taxonomy: TAXONOMY.STRUCTURAL, consistency: 'EXCLUDED', evidence: ['HEADING_OR_NUMBERING_FORM'] };
  }

  const fixed = row.kind === 'locked' || row.kind === 'fixed';
  if (fixed) {
    return {
      taxonomy: TAXONOMY.FIXED,
      consistency: variantCount > 1 ? 'DRIFT' : 'CONSISTENT',
      evidence: row.kind === 'locked' ? ['EXPLICIT_LOCK'] : ['HIGH_CONFIDENCE_IDENTIFIER_FORM']
    };
  }

  if (variantCount <= 1) {
    return {
      taxonomy: TAXONOMY.STABLE,
      consistency: 'CONSISTENT',
      evidence: [row.kind === 'suggested' ? 'PREFLIGHT_SUGGESTION_ONLY' : 'ONE_TARGET_VARIANT_SO_FAR']
    };
  }

  return {
    taxonomy: TAXONOMY.UNKNOWN,
    consistency: 'UNRESOLVED',
    evidence: ['MULTIPLE_TARGET_VARIANTS']
  };
}

export function createTermTelemetry({ maxSamplesPerTerm = 8 } = {}) {
  const rows = new Map();
  let expectedOccurrences = 0;
  let alignedOccurrences = 0;
  const expectedByKind = new Map();
  const alignedByKind = new Map();

  function ensure(candidate) {
    const term = String(candidate?.term || '').trim();
    if (!term) return null;
    const kind = candidate?.kind || 'lexical';
    const key = identityKey(term, kind);
    let row = rows.get(key);
    if (!row) {
      row = {
        source: term,
        lemma: candidate?.lemma || (kind === 'fixed' ? term : lexicalKey(term)),
        kind,
        trust: candidate?.trust || null,
        occurrenceCount: 0,
        variants: new Map(),
        rawVariants: new Map(),
        sourceSurfaces: new Map(),
        sourceRoles: new Map(),
        samples: []
      };
      rows.set(key, row);
    } else if (candidate?.kind === 'locked') {
      row.kind = 'locked';
    } else if (rankKind(candidate?.kind) > rankKind(row.kind)) {
      row.kind = candidate.kind;
    }
    return row;
  }

  return Object.freeze({
    reset() {
      rows.clear();
      expectedOccurrences = 0;
      alignedOccurrences = 0;
      expectedByKind.clear();
      alignedByKind.clear();
    },

    record({ unit, translation, alignments, candidates = [] } = {}) {
      const sourceText = textOf(unit);
      const targetText = String(translation ?? '');
      const aligned = normalizeAlignmentObject(alignments);

      for (const candidate of candidates) {
        const term = String(candidate?.term || '').trim();
        const kind = candidate?.kind || 'lexical';
        const caseSensitive = kind === 'fixed';
        const sourceHit = findSourceTerm(sourceText, term, { caseSensitive });
        if (!term || !sourceHit) continue;
        expectedOccurrences++;
        const metricKind = kind === 'locked' || kind === 'fixed' ? 'fixed' : kind === 'structural' ? 'structural' : kind === 'suggested' ? 'suggested' : 'lexical';
        expectedByKind.set(metricKind, (expectedByKind.get(metricKind) || 0) + 1);

        const hit = aligned.get(term);
        if (!hit) continue;
        const renderedRaw = hit.rendered;
        if (renderedRaw.length < 1 || !targetText.includes(renderedRaw)) continue;
        const rendered = normalizeRenderedForComparison(renderedRaw);
        if (!rendered) continue;

        alignedOccurrences++;
        alignedByKind.set(metricKind, (alignedByKind.get(metricKind) || 0) + 1);
        const row = ensure(candidate);
        if (!row) continue;
        row.occurrenceCount++;
        row.variants.set(rendered, (row.variants.get(rendered) || 0) + 1);
        row.rawVariants.set(renderedRaw, (row.rawVariants.get(renderedRaw) || 0) + 1);
        row.sourceSurfaces.set(sourceHit.surface, (row.sourceSurfaces.get(sourceHit.surface) || 0) + 1);
        row.sourceRoles.set(unit?.role || 'body', (row.sourceRoles.get(unit?.role || 'body') || 0) + 1);
        if (row.samples.length < maxSamplesPerTerm) {
          row.samples.push({
            id: unit?.id ?? null,
            source: clip(sourceText),
            localContext: contextAround(sourceText, sourceHit.index, sourceHit.surface.length),
            sourceSurface: sourceHit.surface,
            sourceUnitRole: unit?.role || 'body',
            // v2 兼容字段：不再计算，也不再参与 taxonomy。
            sourceRoleShape: null,
            target: clip(targetText),
            renderedRaw,
            rendered
          });
        }
      }
    },

    snapshot(extra = {}) {
      const output = [...rows.values()]
        .map((row) => {
          const variants = [...row.variants.entries()]
            .map(([target, count]) => ({ target, count }))
            .sort((a, b) => (b.count - a.count) || a.target.localeCompare(b.target));
          const rawVariants = [...row.rawVariants.entries()]
            .map(([target, count]) => ({ target, count }))
            .sort((a, b) => (b.count - a.count) || a.target.localeCompare(b.target));
          const sourceSurfaces = [...row.sourceSurfaces.entries()]
            .map(([surface, count]) => ({ surface, count }))
            .sort((a, b) => (b.count - a.count) || a.surface.localeCompare(b.surface));
          const sourceRoles = [...row.sourceRoles.entries()].map(([role, count]) => ({ role, count }));
          const classification = classifyRow(row, variants);
          return {
            source: row.source,
            lemma: row.lemma,
            kind: row.kind,
            trust: row.trust || undefined,
            taxonomy: classification.taxonomy,
            consistency: classification.consistency,
            evidence: classification.evidence,
            status: classification.taxonomy,
            occurrenceCount: row.occurrenceCount,
            variantCount: variants.length,
            rawVariantCount: rawVariants.length,
            variants,
            rawVariants,
            sourceSurfaces,
            sourceRoles,
            samples: row.samples.map((x) => ({ ...x }))
          };
        })
        .sort((a, b) =>
          (b.variantCount - a.variantCount) ||
          (b.occurrenceCount - a.occurrenceCount) ||
          a.source.localeCompare(b.source)
        );

      const alignmentByKind = Object.fromEntries(['fixed', 'suggested', 'lexical', 'structural'].map((kind) => {
        const expected = expectedByKind.get(kind) || 0;
        const aligned = alignedByKind.get(kind) || 0;
        return [kind, { expected, aligned, rate: expected ? aligned / expected : 0 }];
      }));

      const semanticExpected = ['fixed', 'suggested', 'lexical'].reduce((n, kind) => n + (expectedByKind.get(kind) || 0), 0);
      const semanticAligned = ['fixed', 'suggested', 'lexical'].reduce((n, kind) => n + (alignedByKind.get(kind) || 0), 0);

      const summary = {
        taxonomyVersion: 3,
        termsObserved: output.length,
        trust: {
          observed: output.filter((x) => !x.trust || x.trust === 'OBSERVED').length,
          suggested: output.filter((x) => x.trust === 'SUGGESTED').length,
          auto: output.filter((x) => x.trust === 'AUTO').length,
          enforced: output.filter((x) => x.trust === 'ENFORCED').length
        },
        expectedOccurrences,
        alignedOccurrences,
        candidateAlignmentRate: expectedOccurrences ? alignedOccurrences / expectedOccurrences : 0,
        semanticAlignmentRate: semanticExpected ? semanticAligned / semanticExpected : 0,
        semanticExpectedOccurrences: semanticExpected,
        semanticAlignedOccurrences: semanticAligned,
        alignmentByKind,
        coverage: expectedOccurrences ? alignedOccurrences / expectedOccurrences : 0,
        fixed: output.filter((x) => x.taxonomy === TAXONOMY.FIXED).length,
        fixedDrift: output.filter((x) => x.taxonomy === TAXONOMY.FIXED && x.consistency === 'DRIFT').length,
        stable: output.filter((x) => x.taxonomy === TAXONOMY.STABLE).length,
        structural: output.filter((x) => x.taxonomy === TAXONOMY.STRUCTURAL).length,
        compositional: output.filter((x) => x.taxonomy === TAXONOMY.COMPOSITIONAL).length,
        contextual: output.filter((x) => x.taxonomy === TAXONOMY.CONTEXTUAL).length,
        polysemous: output.filter((x) => x.taxonomy === TAXONOMY.POLYSEMOUS).length,
        stylistic: output.filter((x) => x.taxonomy === TAXONOMY.STYLISTIC).length,
        unknown: output.filter((x) => x.taxonomy === TAXONOMY.UNKNOWN).length,
        properNameDrift: 0,
        confirmedTermDrift: output.filter((x) => x.kind === 'locked' && x.consistency === 'DRIFT').length,
        ambiguityUnknown: output.filter((x) => [TAXONOMY.UNKNOWN, TAXONOMY.CONTEXTUAL].includes(x.taxonomy)).length
      };

      return { summary, rows: output, ...extra };
    }
  });
}
