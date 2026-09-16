import { fromYaml, normalizeRules } from '../shared/rules-yaml.js';
import { presetOptions } from '../prompt/presets.js';
import { translateUi } from '../shared/ui-language.js';

/** Read-only projections: no DOM, settings writes, messages or retained state. */
function alignmentPercent(summary) {
  const expected = summary.semanticExpectedOccurrences ?? summary.expectedOccurrences;
  const rate = summary.semanticAlignmentRate ?? summary.candidateAlignmentRate ?? summary.coverage ?? 0;
  return expected ? Math.round(rate * 100) : 0;
}

export function consistencyView(data, enabled, language = '简体中文') {
  const t = (...args) => translateUi(language, ...args);
  if (!enabled) return { text: '', title: '', copy: false };
  if (!data?.summary) return { text: t('已开启 · 只记录跨段变体与分类，不修改译文'), title: '', copy: false };
  const s = { termsObserved: 0, fixedDrift: 0, structural: 0, unknown: 0, ...data.summary };
  const suspects = (data.rows || []).filter(row => row.consistency === 'DRIFT' || row.taxonomy === 'UNKNOWN')
    .slice(0, 6).map(row => `${row.source}: ${row.variants.map(variant => variant.target).join(' / ')} [${row.taxonomy}]`);
  const cacheNote = s.cachedUnitsExcludedFromObservation ? t` · ${s.cachedUnitsExcludedFromObservation} 个缓存单元未计入观测` : '';
  const suffix = suspects.length ? ` · ${suspects.join('；')}` : '';
  return {
    text: t`已观测 ${s.termsObserved} 词 · 对齐 ${alignmentPercent(s)}% · 固定项漂移 ${s.fixedDrift} · 结构项 ${s.structural} · 待判 ${s.unknown}${cacheNote}${suffix}`,
    title: JSON.stringify(data, null, 2), copy: true
  };
}

export function contextPeek(live = {}, presetId, language = '简体中文') {
  const t = (...args) => translateUi(language, ...args);
  const profile = fromYaml(live.profileYaml || '');
  const domain = profile.domain.slice(0, 2).join(' / ');
  const preset = presetOptions().find(item => item.id === (live.presetId || presetId));
  return domain || (live.hasProfile ? t('已读取') : t(preset?.label || t('自动读取')));
}

export function preflightInfo(profile, hash, language = '简体中文') {
  const t = (...args) => translateUi(language, ...args);
  const rules = normalizeRules(profile);
  const preferred = Object.keys(rules.preferred).length;
  const risky = Object.keys(rules.risky).length;
  const suffix = hash ? t` · 快照 ${hash.slice(0, 8)}` : '';
  return preferred + risky + rules.keep.length
    ? t`已读取页面语境 · ${preferred} 个术语建议 · ${risky} 个歧义提示${suffix}`
    : t`已读取页面语境；当前没有额外建议${suffix}`;
}
