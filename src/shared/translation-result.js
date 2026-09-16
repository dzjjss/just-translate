const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const NON_LATIN_SOURCE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
const NON_LATIN_SOURCE_GLOBAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/gu;

/**
 * 模型偶尔会为短列表项返回空串或只有一个 Markdown 横线。它们在 JSON 结构上合法，
 * 但渲染后会变成空步骤/空项目，必须视为漏项并进入同一条二分恢复路径。
 */
export function isUsableTranslation(source, translation, targetLang = '') {
  if (typeof translation !== 'string') return false;
  const src = String(source || '').trim();
  const out = translation.trim();
  if (!out) return false;
  if (LETTER_OR_NUMBER.test(src) && !LETTER_OR_NUMBER.test(out)) return false;

  // 翻成英语时，纯粹原样返回一条含非拉丁文字的源文通常也是短条目漏翻。
  // 只拒绝完全相同的结果；人名等正常夹带原文不会被误伤。
  const nonLatinCount = (src.match(NON_LATIN_SOURCE_GLOBAL) || []).length;
  const looksLikePhrase = nonLatinCount >= 4 || /[。！？!?]/u.test(src);
  if (
    /english|英语|英文/i.test(String(targetLang)) &&
    NON_LATIN_SOURCE.test(src) &&
    looksLikePhrase &&
    out === src
  ) return false;
  return true;
}
