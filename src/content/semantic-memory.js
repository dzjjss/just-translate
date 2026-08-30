import { findSourceTerm, normalizeRenderedForComparison } from './term-consistency.js';

/**
 * Session-scoped contextual memory.
 *
 * 不保存裸词 canonical；键是 (lemma + exact local trigger)。
 * 相同 trigger 的目标只在“比较归一化后”唯一时可复用：排版引号差异不会触发冲突，
 * 但真正不同的译法仍会熔断。真实 raw rendering 继续保留，供 hint 与 telemetry 回看。
 */

const WORD_RE = /[A-Za-z][A-Za-z0-9'’_-]*/g;

function lemmaOf(candidate) {
  return String(candidate?.lemma || candidate?.term || '').trim().toLowerCase();
}

function normalizedWords(text) {
  const out = [];
  for (const match of String(text || '').matchAll(WORD_RE)) {
    out.push({ surface: match[0], lower: match[0].toLowerCase(), index: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return out;
}

/** occurrence 左右各两枚词形成 exact normalized trigger。 */
export function contextTrigger(text, term, { radius = 2 } = {}) {
  const source = String(text || '');
  const hit = findSourceTerm(source, term, { caseSensitive: false });
  if (!hit) return '';
  const words = normalizedWords(source);
  if (!words.length) return '';

  let first = words.findIndex((w) => w.end > hit.index);
  if (first < 0) return '';
  const termEnd = hit.index + hit.surface.length;
  let last = first;
  while (last + 1 < words.length && words[last + 1].index < termEnd) last++;

  const start = Math.max(0, first - radius);
  const end = Math.min(words.length, last + radius + 1);
  return words.slice(start, end).map((w) => w.lower).join(' ');
}

function preferredRaw(targetRow) {
  return [...targetRow.raws.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0] || targetRow.normalized;
}

export function createSemanticMemory({ maxEntries = 96 } = {}) {
  const contextual = new Map();
  let observations = 0;
  let hintLookups = 0;
  let hintHits = 0;
  let hintMisses = 0;
  let hintSuppressedConflicts = 0;
  let precedentOutcomes = 0;
  let precedentMatched = 0;
  let precedentDiverged = 0;
  let precedentUnaligned = 0;

  function keyFor(candidate, trigger) {
    const lemma = lemmaOf(candidate);
    return lemma && trigger ? `${lemma}\u0000${trigger}` : '';
  }

  function trim() {
    while (contextual.size > maxEntries) {
      const first = contextual.keys().next().value;
      if (first == null) break;
      contextual.delete(first);
    }
  }

  function stats() {
    const rows = [...contextual.values()];
    return {
      contextualEntries: rows.length,
      usableContextualEntries: rows.filter((x) => x.targets.size === 1).length,
      conflictedContextualEntries: rows.filter((x) => x.targets.size !== 1).length,
      observations,
      hintLookups,
      hintHits,
      hintMisses,
      hintSuppressedConflicts,
      // 这里只观察“提供先例后，实际 alignment 是否相同”，不声称先例造成了该结果。
      precedentOutcomes,
      precedentMatched,
      precedentDiverged,
      precedentUnaligned,
      precedentMatchRate: (precedentMatched + precedentDiverged)
        ? precedentMatched / (precedentMatched + precedentDiverged)
        : 0
    };
  }

  return Object.freeze({
    reset() {
      contextual.clear();
      observations = 0;
      hintLookups = 0;
      hintHits = 0;
      hintMisses = 0;
      hintSuppressedConflicts = 0;
      precedentOutcomes = 0;
      precedentMatched = 0;
      precedentDiverged = 0;
      precedentUnaligned = 0;
    },

    observe({ unit, translation, alignments, candidates = [] } = {}) {
      const source = String(unit?.text || '');
      const targetText = String(translation || '');
      if (!alignments || typeof alignments !== 'object' || Array.isArray(alignments)) return;

      for (const candidate of candidates) {
        if (!candidate || candidate.kind === 'locked' || candidate.kind === 'fixed' || candidate.kind === 'structural') continue;
        const term = String(candidate.term || '').trim();
        const raw = String(alignments[term] || '').trim();
        const normalized = normalizeRenderedForComparison(raw);
        if (!term || !raw || !normalized || !targetText.includes(raw)) continue;
        const trigger = contextTrigger(source, term);
        const key = keyFor(candidate, trigger);
        if (!key) continue;

        let row = contextual.get(key);
        if (!row) {
          row = { lemma: lemmaOf(candidate), term, trigger, targets: new Map(), observations: 0 };
          contextual.set(key, row);
        }
        let targetRow = row.targets.get(normalized);
        if (!targetRow) {
          targetRow = { normalized, count: 0, raws: new Map() };
          row.targets.set(normalized, targetRow);
        }
        targetRow.count++;
        targetRow.raws.set(raw, (targetRow.raws.get(raw) || 0) + 1);
        row.observations++;
        observations++;
        contextual.delete(key);
        contextual.set(key, row);
        trim();
      }
    },

    hintsFor(items, candidates = [], { maxHints = 8 } = {}) {
      const hints = [];
      const seen = new Set();
      for (const unit of items || []) {
        const source = String(unit?.text || '');
        for (const candidate of candidates || []) {
          if (!candidate || candidate.kind === 'locked' || candidate.kind === 'fixed' || candidate.kind === 'structural') continue;
          const term = String(candidate.term || '').trim();
          if (!term) continue;
          const trigger = contextTrigger(source, term);
          const key = keyFor(candidate, trigger);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          hintLookups++;
          const row = contextual.get(key);
          if (!row) {
            hintMisses++;
            continue;
          }
          if (row.targets.size !== 1) {
            hintSuppressedConflicts++;
            continue;
          }
          const [targetRow] = [...row.targets.values()];
          hints.push({
            term,
            lemma: row.lemma,
            trigger,
            target: preferredRaw(targetRow),
            normalizedTarget: targetRow.normalized,
            observations: targetRow.count,
            provenance: 'SESSION_CONTEXTUAL_PRECEDENT'
          });
          hintHits++;
          if (hints.length >= maxHints) return hints;
        }
      }
      return hints;
    },

    recordHintOutcomes({ unit, translation, alignments, hints = [] } = {}) {
      const source = String(unit?.text || '');
      const targetText = String(translation || '');
      const aligned = alignments && typeof alignments === 'object' && !Array.isArray(alignments)
        ? alignments
        : {};
      for (const hint of hints || []) {
        const term = String(hint?.term || '').trim();
        if (!term || contextTrigger(source, term) !== hint?.trigger) continue;
        precedentOutcomes++;
        const raw = String(aligned[term] || '').trim();
        const actual = normalizeRenderedForComparison(raw);
        if (!raw || !actual || !targetText.includes(raw)) {
          precedentUnaligned++;
          continue;
        }
        if (actual === hint.normalizedTarget) precedentMatched++;
        else precedentDiverged++;
      }
    },

    stats,

    snapshot() {
      const rows = [...contextual.values()].map((row) => ({
        lemma: row.lemma,
        term: row.term,
        trigger: row.trigger,
        observations: row.observations,
        targets: [...row.targets.values()].map((target) => ({
          target: target.normalized,
          count: target.count,
          rawVariants: [...target.raws.entries()].map(([raw, count]) => ({ raw, count }))
        })),
        usable: row.targets.size === 1
      }));
      return { ...stats(), rows };
    }
  });
}
