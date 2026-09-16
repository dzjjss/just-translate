import { languageCode } from './machine-languages.js';

/** Values remain compatible with existing prompts, MT adapters and saved preferences. */
export const LANGUAGES = Object.freeze([
  ['zh-CN', '简体中文', '简体中文'], ['zh-TW', '繁體中文', '繁體中文'],
  ['en', 'English', 'English'], ['fr', 'Français', 'Français'],
  ['ja', '日本語', '日本語'], ['ko', '한국어', '한국어'],
  ['de', 'Deutsch', 'Deutsch'], ['es', 'Español', 'Español'],
  ['pt', 'Português', 'Português'], ['it', 'Italiano', 'Italiano'],
  ['nl', 'Nederlands', 'Nederlands'], ['pl', 'Polski', 'Polski'],
  ['ru', 'Русский', 'Русский'], ['uk', 'Українська', 'Українська'],
  ['ar', 'العربية', 'العربية'], ['tr', 'Türkçe', 'Türkçe'],
  ['vi', 'Tiếng Việt', 'Tiếng Việt'], ['th', 'ไทย', 'ไทย'],
  ['id', 'Bahasa Indonesia', 'Bahasa Indonesia'],
  ['hi', 'hi', 'हिन्दी'], ['bn', 'bn', 'বাংলা'], ['he', 'he', 'עברית'],
  ['fa', 'fa', 'فارسی'], ['sv', 'sv', 'Svenska'], ['da', 'da', 'Dansk'],
  ['fi', 'fi', 'Suomi'], ['no', 'no', 'Norsk'], ['cs', 'cs', 'Čeština'],
  ['el', 'el', 'Ελληνικά'], ['ro', 'ro', 'Română'], ['hu', 'hu', 'Magyar'],
  ['ms', 'ms', 'Bahasa Melayu'], ['fil', 'fil', 'Filipino']
].map(([code, value, label]) => Object.freeze({ code, value, label })));

export function normalizeLanguage(value) {
  const code = languageCode(value).toLowerCase() || localeCode(value);
  if (!code || code === 'und') return '';
  const base = code.split('-')[0];
  return ({ iw: 'he', in: 'id', nb: 'no', nn: 'no', tl: 'fil' })[base] || base;
}

export function languageOption(value) {
  // Region/script subtags affect only the initial UI preference, never page routing.
  const code = languageCode(value).toLowerCase() || localeCode(value);
  if (code === 'zh' || code.startsWith('zh-')) {
    return LANGUAGES.find(item => item.code === (/tw|hk|mo|hant/.test(code) ? 'zh-TW' : 'zh-CN'));
  }
  return LANGUAGES.find(item => item.code === normalizeLanguage(code));
}

function localeCode(value) {
  try { return new Intl.Locale(String(value).replaceAll('_', '-')).baseName.toLowerCase(); }
  catch { return ''; }
}

export function languageLabel(value) {
  return languageOption(value)?.label || String(value || '');
}

/** No guessed Chinese default: unsupported browser locales require an explicit choice. */
export function browserUserLanguage() {
  try {
    const locale = globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language;
    return languageOption(locale)?.value || '';
  } catch { return ''; }
}

export function interfaceLanguage(value) {
  return normalizeLanguage(value) === 'zh' ? 'zh-CN' : 'en';
}
