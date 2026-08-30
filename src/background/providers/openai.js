import { ApiError } from '../../shared/logger.js';
import { joinUrl, readError } from './http.js';

/**
 * 记住哪些「地址+模型」不支持 response_format，避免每批都试错一次。
 * 粒度必须到模型：OpenRouter 这类聚合站下面，模型 A 不支持不代表模型 B 不支持，
 * 只按 base 记会让整个聚合站被一个模型拖下水 —— 做模型对比时这会直接污染结论。
 */
const noJsonMode = new Set();

/**
 * OpenAI /chat/completions 线协议。
 * 所有说这套协议的供应商共用它，差异通过 extraBody 注入（见 providers/index.js）。
 */
export const openaiWire = {
  id: 'openai',

  /** 拉取可用模型：绝大多数 OpenAI 兼容服务都提供 GET /models */
  async listModels({ base, apiKey, auth, extraQuery, extraHeaders, signal }) {
    let url = joinUrl(base, 'models');
    const headers = {};
    const style = auth || 'bearer';
    if (style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    else if (style === 'query') url += (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(apiKey)}`;
    else headers[style] = apiKey;
    if (extraQuery) url += (url.includes('?') ? '&' : '?') + extraQuery;
    Object.assign(headers, extraHeaders || {});

    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw await readError(res, url);
    return res.json();
  },

  async complete({ base, apiKey, model, system, user, temperature, extraBody, auth, extraQuery, extraHeaders, signal }) {
    let url = joinUrl(base, 'chat/completions');
    // 各家把 Key 放的位置不一样：Bearer 头、自定义头、或者查询串。
    // 抽成 auth 描述以后，接一家新服务商通常还是只加一条记录。
    const headers = { 'Content-Type': 'application/json' };
    const style = auth || 'bearer';
    if (style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    else if (style === 'query') url += (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(apiKey)}`;
    else headers[style] = apiKey; // 'api-key'（Azure）、'x-api-key' 等自定义头
    if (extraQuery) url += (url.includes('?') ? '&' : '?') + extraQuery;
    Object.assign(headers, extraHeaders || {});
    const send = (jsonMode) =>
      fetch(url, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify({
          model,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(extraBody || {})
        })
      });

    const jsonKey = `${base}|${model}`;
    const wantJson = !noJsonMode.has(jsonKey);
    let res = await send(wantJson);

    // 部分兼容服务端不认 response_format，降级一次并记住
    if (!res.ok && wantJson && res.status === 400) {
      const peek = await res.clone().text().catch(() => '');
      if (/response_format|json_object|unsupported|unknown field/i.test(peek)) {
        noJsonMode.add(jsonKey);
        res = await send(false);
      }
    }

    if (!res.ok) throw await readError(res, url);

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      // DeepSeek 官方文档提示 JSON 模式偶尔返回空 content，这类情况值得重试一次
      throw new ApiError('返回内容为空或结构不符合 OpenAI 规范', {
        status: res.status,
        retryable: true,
        body: JSON.stringify(data).slice(0, 300)
      });
    }
    return { text, usage: data?.usage || null };
  }
};
