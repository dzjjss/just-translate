import { ApiError } from '../../shared/logger.js';
import { joinUrl, readError } from './http.js';

/**
 * Anthropic /v1/messages 线协议。
 * 注意：不能用 assistant prefill 强制 JSON 起头 —— 新模型会直接 400，
 * 这里改为完全依赖 system 里的输出合同 + 容错解析器（与 OpenAI 那条线一致）。
 */
/**
 * 请求头集中构建。之前这条线把 x-api-key 写死、完全忽略 auth / extraHeaders，
 * 而 README 宣称"认证方式抽象成 auth 字段" —— 那句话当时只在 openai 线上成立。
 */
function headersFor({ apiKey, auth = 'x-api-key', extraHeaders, json = false }) {
  const headers = {
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (json) headers['Content-Type'] = 'application/json';
  if (auth === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  else headers[auth] = apiKey;
  Object.assign(headers, extraHeaders || {});
  return headers;
}

export const anthropicWire = {
  id: 'anthropic',

  /** 原生 API 同样有 GET /v1/models，面板不该因为换了线协议就失去"拉模型"能力 */
  async listModels({ base, apiKey, auth, extraQuery, extraHeaders, signal }) {
    let url = joinUrl(base, 'models');
    if (extraQuery) url += (url.includes('?') ? '&' : '?') + extraQuery;
    const res = await fetch(url, { signal, headers: headersFor({ apiKey, auth, extraHeaders }) });
    if (!res.ok) throw await readError(res, url);
    return res.json();
  },

  async complete({ base, apiKey, model, system, user, temperature, extraBody, auth, extraQuery, extraHeaders, signal }) {
    let url = joinUrl(base, 'messages');
    if (extraQuery) url += (url.includes('?') ? '&' : '?') + extraQuery;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: headersFor({ apiKey, auth, extraHeaders, json: true }),
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
        ...(extraBody || {})
      })
    });

    if (!res.ok) throw await readError(res, url);

    const data = await res.json();
    const text = (data?.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) {
      throw new ApiError('返回内容为空或结构不符合 Anthropic 规范', {
        status: res.status,
        retryable: true,
        body: JSON.stringify(data).slice(0, 300)
      });
    }
    return { text, usage: data?.usage || null };
  }
};
