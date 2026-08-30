/**
 * Prompt-only YAML serializer.
 *
 * 机器响应仍然使用 JSON；这里仅把发送给模型的结构化输入写成一个很小、确定性的
 * YAML 子集。字符串统一用 JSON 的双引号转义规则——JSON 双引号字符串本身也是
 * 合法 YAML 标量，因此不用引入完整 YAML 依赖，也不会被冒号、井号、换行等内容弄坏。
 */
function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value ?? ''));
}

function render(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    const lines = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const nested = render(item, indent + 2);
        lines.push(`${pad}-`);
        lines.push(...nested);
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return lines;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return [`${pad}{}`];
    const lines = [];
    for (const [key, item] of entries) {
      const k = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
      if (item && typeof item === 'object') {
        lines.push(`${pad}${k}:`);
        lines.push(...render(item, indent + 2));
      } else {
        lines.push(`${pad}${k}: ${scalar(item)}`);
      }
    }
    return lines;
  }
  return [`${pad}${scalar(value)}`];
}

export function toPromptYaml(value) {
  return render(value, 0).join('\n');
}
