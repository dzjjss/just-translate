/**
 * 填 Key 和模型时的纠错与提示，纯函数，可测。
 * 目标是让用户不用去翻各家文档：地址粘错了自动纠、Key 明显不对当场提示、
 * 模型名不用背——从服务商那里拉一份回来选。
 */

/** 用户最常见的错误：把文档里的完整请求地址整条粘进来 */
const TAIL_PATHS = [
  '/chat/completions',
  '/v1/chat/completions',
  '/completions',
  '/messages',
  '/v1/messages'
];

export function normalizeBase(raw, provider) {
  let url = String(raw || '').trim();
  if (!url) return { value: '', note: '' };

  const notes = [];

  // 粘贴时常带上引号和行尾逗号，而且往往是连着的（形如 "https://x.com",）
  url = url.replace(/^[\s"'`]+/, '').replace(/[\s"'`,]+$/, '');

  if (!/^https?:\/\//i.test(url)) {
    if (/^localhost|^127\.|^0\.0\.0\.0|^\[::1\]/.test(url)) url = 'http://' + url;
    else url = 'https://' + url;
    notes.push('已补上协议头');
  }

  url = url.replace(/\/+$/, '');

  for (const tail of TAIL_PATHS) {
    if (url.toLowerCase().endsWith(tail)) {
      url = url.slice(0, -tail.length).replace(/\/+$/, '');
      notes.push('已去掉末尾的接口路径，这里只填到根地址');
      break;
    }
  }

  // 官方 base 带 /v1 而用户漏了时补上（自定义端点不猜）
  const wantV1 = provider?.defaultBase?.endsWith('/v1');
  if (wantV1 && !/\/v\d+$/i.test(url)) {
    try {
      const u = new URL(url);
      const def = new URL(provider.defaultBase);
      if (u.hostname === def.hostname && u.pathname.replace(/\/+$/, '') === '') {
        url += '/v1';
        notes.push('已补上 /v1');
      }
    } catch {
      /* 地址还没填完整，先不动 */
    }
  }

  return { value: url, note: notes.join('；') };
}

/**
 * Key 只做软校验：格式不符只提示，不拦截。
 * 各家随时可能换前缀，硬拦会把能用的 Key 挡在外面。
 */
export function checkKey(key, provider) {
  const k = String(key || '').trim();
  if (!k) return { level: 'empty', message: '' };
  if (/\s/.test(k)) return { level: 'warn', message: 'Key 里有空格或换行，多半是复制时带进来的' };
  if (provider?.keyPattern && !new RegExp(provider.keyPattern).test(k)) {
    return {
      level: 'warn',
      message: `这家的 Key 通常形如 ${provider.keyHint || '（见文档）'}，确认没贴错？`
    };
  }
  return { level: 'ok', message: '' };
}

/** /v1/models 各家返回结构略有差异，都压成一个 id 数组 */
export function parseModelList(data) {
  const raw = Array.isArray(data) ? data : data?.data || data?.models || [];
  const ids = raw
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model))
    .filter((x) => typeof x === 'string' && x.trim());
  return [...new Set(ids)].sort();
}

/** 只留可能用于对话补全的模型，免得列表里混进一堆 embedding / tts / 图像模型 */
export function filterChatModels(ids) {
  const noise = /(embed|embedding|whisper|tts|audio|speech|image|vision-only|rerank|moderation|dall|sora|clip)/i;
  const chat = ids.filter((id) => !noise.test(id));
  return chat.length ? chat : ids;
}
