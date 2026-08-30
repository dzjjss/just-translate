const ALIASES = new Map([
  ['简体中文', 'zh-CN'],
  ['简体', 'zh-CN'],
  ['中文', 'zh-CN'],
  ['chinese', 'zh-CN'],
  ['chinese simplified', 'zh-CN'],
  ['simplified chinese', 'zh-CN'],
  ['繁體中文', 'zh-TW'],
  ['繁体中文', 'zh-TW'],
  ['繁體', 'zh-TW'],
  ['繁体', 'zh-TW'],
  ['chinese traditional', 'zh-TW'],
  ['traditional chinese', 'zh-TW'],
  ['english', 'en'],
  ['英语', 'en'],
  ['英文', 'en'],
  ['日本語', 'ja'],
  ['日语', 'ja'],
  ['japanese', 'ja'],
  ['français', 'fr'],
  ['法语', 'fr'],
  ['french', 'fr'],
  ['deutsch', 'de'],
  ['德语', 'de'],
  ['german', 'de'],
  ['español', 'es'],
  ['西班牙语', 'es'],
  ['spanish', 'es'],
  ['한국어', 'ko'],
  ['韩语', 'ko'],
  ['korean', 'ko'],
  ['русский', 'ru'],
  ['俄语', 'ru'],
  ['russian', 'ru'],
  ['português', 'pt'],
  ['葡萄牙语', 'pt'],
  ['portuguese', 'pt'],
  ['italiano', 'it'],
  ['意大利语', 'it'],
  ['italian', 'it'],
  ['nederlands', 'nl'],
  ['荷兰语', 'nl'],
  ['dutch', 'nl'],
  ['polski', 'pl'],
  ['波兰语', 'pl'],
  ['polish', 'pl'],
  ['العربية', 'ar'],
  ['阿拉伯语', 'ar'],
  ['arabic', 'ar'],
  ['українська', 'uk'],
  ['乌克兰语', 'uk'],
  ['ukrainian', 'uk'],
  ['ไทย', 'th'],
  ['泰语', 'th'],
  ['thai', 'th'],
  ['tiếng việt', 'vi'],
  ['越南语', 'vi'],
  ['vietnamese', 'vi'],
  ['türkçe', 'tr'],
  ['土耳其语', 'tr'],
  ['turkish', 'tr'],
  ['bahasa indonesia', 'id'],
  ['印度尼西亚语', 'id'],
  ['indonesian', 'id']
]);

function canonical(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const alias = ALIASES.get(text.toLowerCase()) || ALIASES.get(text);
  if (alias) return alias;
  if (!/^[a-z]{2,3}(?:[-_][a-z]{2,8})?$/i.test(text)) return '';
  const [language, region] = text.replace('_', '-').split('-');
  return region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
}

/**
 * 设置里的目标语言对 LLM 可以是自然语言；机器翻译接口只接受语言码。
 * 映射失败时明确报错，不静默猜成中文或英文。
 */
export function resolveMachineTarget(target, providerId) {
  const code = canonical(target);
  if (!code) {
    throw new Error(`免 Key 引擎不认识目标语言“${String(target || '').trim()}”，请填写常见语言名或 ISO 语言码`);
  }
  if (providerId === 'deeplx') {
    // DeepLX 的兼容示例与较老 DeepL 网页协议使用 ZH；默认中文必须优先兼容它。
    if (code === 'zh-CN') return 'ZH';
    if (code === 'zh-TW') return 'ZH-HANT';
    return code.toUpperCase();
  }
  return code;
}
