import { LIMITS } from '../shared/constants.js';
import { classifyPage } from '../prompt/classify.js';
import { fromYaml, isEmptyRules } from '../shared/rules-yaml.js';

/**
 * RuntimeConfig + 当前页面元数据 -> 不可变 PageContext。
 * 这里是站点覆盖、自动 preset、用户规则与派生 selector 的唯一合并点。
 */
export function resolvePageContext(config = {}, context = {}) {
  const host = String(context.hostname || '').toLowerCase();
  const rule = (config.siteRules || []).find(
    (item) => item?.host && (host === item.host.toLowerCase() || host.endsWith('.' + item.host.toLowerCase()))
  );

  let presetId;
  let presetReason;
  if (config.presetId && config.presetId !== 'auto') {
    presetId = config.presetId;
    presetReason = 'manual';
  } else {
    const hit = classifyPage(context, config.siteRules || []);
    presetId = hit.presetId;
    presetReason = hit.reason;
  }

  const background = (rule?.background || config.background || '').slice(0, LIMITS.BACKGROUND_MAX_CHARS);
  const rulesText = rule?.rulesText || config.rulesText || '';
  const parsed = rulesText ? fromYaml(rulesText) : null;
  const userRules = parsed && !isEmptyRules(parsed) ? parsed : null;

  // config 不可变：站点选择器只存在于本页派生快照里。
  const pageConfig = Object.freeze({
    ...config,
    skipSelectors: [config.skipSelectors, rule?.selectors].filter(Boolean).join(', ')
  });

  return Object.freeze({
    presetId,
    presetReason,
    background,
    userRules,
    pageConfig,
    siteRule: rule || null
  });
}
