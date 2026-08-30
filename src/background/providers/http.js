import { ApiError } from '../../shared/logger.js';

/** 允许用户填 https://x.com、https://x.com/v1、https://x.com/v1/ 任意一种 */
export function joinUrl(base, path) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  if (b.endsWith('/' + p)) return b;
  return `${b}/${p}`;
}

/**
 * 错误消息里不能带 query string —— auth: 'query' 的端点把 Key 拼在里面，
 * 而这条消息会显示在面板上、也会进 debug 日志。
 */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return String(raw).split('?')[0];
  }
}

export async function readError(res, url) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 600);
  } catch {
    /* ignore */
  }
  const retryAfter = Number(res.headers.get('retry-after')) || 0;
  const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
  const hint =
    res.status === 401 || res.status === 403
      ? '认证信息无效或服务端拒绝访问'
      : res.status === 404
        ? `接口不存在：${safeUrl(url)}，检查地址和接口路径`
        : res.status === 429
          ? '触发速率限制，降低并发或稍后重试'
          : `HTTP ${res.status}`;

  return new ApiError(hint, {
    status: res.status,
    body,
    retryable,
    retryAfterMs: retryAfter * 1000
  });
}
