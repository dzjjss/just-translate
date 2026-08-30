import { ApiError } from '../../shared/logger.js';
import { readError } from './http.js';

/** Google Translate 网页端使用的非官方接口；协议可能由 Google 随时调整。 */
export const googleTranslateWire = {
  id: 'google-translate',

  async translate({ base, text, sourceLang = 'auto', targetLang, signal }) {
    const root = String(base || 'https://translate.googleapis.com').replace(/\/+$/, '');
    const url = `${root}/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `q=${encodeURIComponent(String(text || ''))}`
    });
    if (!res.ok) throw await readError(res, url);
    const data = await res.json();
    const rows = Array.isArray(data?.sentences) ? data.sentences : (Array.isArray(data?.[0]) ? data[0] : []);
    const translated = rows.map((row) => row?.trans || (Array.isArray(row) ? row[0] : '') || '').join('');
    if (!translated.trim()) {
      throw new ApiError('Google Translate 返回了空内容或未知结构', {
        status: res.status,
        retryable: true,
        body: JSON.stringify(data).slice(0, 300)
      });
    }
    return { text: translated, detectedLanguage: data?.src || '' };
  }
};
