/** 双 32 位混合哈希，够快、碰撞率对缓存场景足够低。 */
export function hashString(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 2654435761) >>> 0;
  }
  return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36);
}
