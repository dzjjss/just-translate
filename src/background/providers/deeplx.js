import { ApiError } from '../../shared/logger.js';
import { readError } from './http.js';

/** DeepLX 兼容接口。base 是完整 POST 地址，不再自动拼路径。 */
export const deepLXWire = {
  id: 'deeplx',

  async translate({ base, text, sourceLang = 'AUTO', targetLang, signal }) {
    const url = String(base || '').trim();
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || ''), source_lang: sourceLang, target_lang: targetLang })
    });
    if (!res.ok) throw await readError(res, url);
    const data = await res.json();
    const translated = typeof data?.data === 'string' ? data.data : data?.translation;
    if ((data?.code != null && Number(data.code) !== 200) || typeof translated !== 'string' || !translated.trim()) {
      throw new ApiError(data?.message || 'DeepLX 返回了空内容或未知结构', {
        status: res.status,
        retryable: Number(data?.code) === 429 || Number(data?.code) >= 500,
        body: JSON.stringify(data).slice(0, 300)
      });
    }
    return { text: translated, detectedLanguage: data?.source_lang || data?.sourceLang || '' };
  }
};

