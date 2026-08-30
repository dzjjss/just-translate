/**
 * 安装时不要任何主机权限。用户填了哪个 API 域名，就只申请那一个 origin。
 * chrome.permissions.request() 必须在用户手势里调用，所以请求动作放在 popup。
 */

export function originPatternFromUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasApiPermission(apiBase) {
  const origin = originPatternFromUrl(apiBase);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin] });
}

