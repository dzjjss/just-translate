/**
 * 页面语境预设。每个 preset 只贡献 system prompt 里的一段"领域指令"，
 * 其余合同（JSON 结构、通用翻译规则）由 build.js 统一负责，避免各预设互相漂移。
 */

export const PRESETS = {
  general: {
    label: '通用',
    guidance: [
      'DOMAIN: general web content.',
      'Prefer natural, idiomatic phrasing over literal word order.',
      'Preserve the register of the source: casual stays casual, formal stays formal.'
    ].join('\n')
  },
  technical: {
    label: '技术文档',
    guidance: [
      'DOMAIN: software / networking / engineering documentation.',
      'Keep every identifier untranslated and byte-identical: API names, CLI flags, env vars, file paths, protocol names, error codes, config keys, type names.',
      'Translate a term consistently across the whole batch; never alternate between two renderings.',
      'When a term has an established local convention, use it; otherwise keep the English term and do not invent a neologism.',
      'Imperative instructions stay imperative.'
    ].join('\n')
  },
  academic: {
    label: '学术论文',
    guidance: [
      'DOMAIN: academic paper or research writing.',
      'Preserve argument structure, hedging and modality exactly: "suggests" must not become "proves".',
      'Keep citation markers, figure/table/equation references and author names untouched.',
      'Use the discipline\'s standard terminology; when a term is ambiguous, keep the original in parentheses on first occurrence only.'
    ].join('\n')
  },
  news: {
    label: '新闻报道',
    guidance: [
      'DOMAIN: news reporting.',
      'Names of people, institutions, places, dates, quantities and currencies must survive translation without drift.',
      'Preserve attribution and epistemic distance: "according to", "alleged", "reportedly" must remain visible.',
      'Headlines stay compact; do not expand them into full sentences.'
    ].join('\n')
  },
  forum: {
    label: '论坛/社区',
    guidance: [
      'DOMAIN: forum, comment thread or social post.',
      'Keep the colloquial voice, humour, sarcasm and rudeness intact — do not sanitise or formalise.',
      'Render slang and community jargon with an equivalent that a local reader of the same community would use.',
      'Keep @mentions, subreddit/channel names, emoji and quoted fragments as-is.'
    ].join('\n')
  }
};

export const PRESET_IDS = Object.keys(PRESETS);

export function presetOptions() {
  return [{ id: 'auto', label: '自动识别' }].concat(
    PRESET_IDS.map((id) => ({ id, label: PRESETS[id].label }))
  );
}

export function getPreset(id) {
  return PRESETS[id] || PRESETS.general;
}
