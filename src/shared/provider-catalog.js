/**
 * Provider catalog 是纯数据，popup 和 background 都可以依赖；网络 wire 留在 background。
 * 这样 UI 不再跨层 import background/providers，只为了拿 label/default model。
 */
export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'openai',
    keyHint: 'sk-proj-… 或 sk-…',
    keyPattern: '^sk-',
    keyUrl: 'https://platform.openai.com/api-keys',
    modelHint: 'gpt-4o-mini、gpt-4.1-mini',
    label: 'OpenAI 兼容 · 通用',
    wire: 'openai',
    defaultBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    hint: 'OpenAI / OpenRouter / Qwen / Groq / vLLM / LM Studio 等任何 /chat/completions 服务',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'qwen-plus']
  },
  {
    id: 'deepseek',
    keyHint: 'sk-… （32 位十六进制）',
    keyPattern: '^sk-',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    modelHint: 'deepseek-v4-flash 最便宜',
    label: 'DeepSeek 官方 · 省钱档',
    wire: 'openai',
    defaultBase: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    extraBody: { thinking: { type: 'disabled' }, max_tokens: 8192 },
    hint: '已关闭思考模式。峰时为 UTC 01:00-04:00 与 06:00-10:00，其余时段半价',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  },
  {
    id: 'anthropic',
    auth: 'x-api-key',
    keyHint: 'sk-ant-…',
    keyPattern: '^sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    modelHint: 'claude-sonnet-4-6',
    label: 'Anthropic · /v1/messages',
    wire: 'anthropic',
    defaultBase: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    hint: '浏览器直连需要 dangerous-direct-browser-access 头，已自动带上',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5']
  },
  {
    id: 'gemini',
    keyHint: 'AQ.Ab… （新格式）或旧的 AIza…',
    keyPattern: '^(AIza|AQ\\.)',
    keyUrl: 'https://aistudio.google.com/apikey',
    modelHint: 'gemini-3.7-flash',
    label: 'Google Gemini · OpenAI 兼容端点',
    wire: 'openai',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.7-flash',
    hint: '走 Gemini 的 OpenAI 兼容层，Key 用 Bearer 传；Gemini 3.6+ 不发送旧 sampling 参数',
    omitTemperature: true,
    models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
  },
  {
    id: 'azure',
    keyHint: '32 位十六进制，无前缀',
    keyPattern: '^[A-Za-z0-9]{20,}$',
    keyUrl: 'https://portal.azure.com/',
    modelHint: '填部署名，不是模型名',
    label: 'Azure OpenAI',
    wire: 'openai',
    defaultBase: 'https://<资源名>.openai.azure.com/openai/deployments/<部署名>',
    defaultModel: '',
    auth: 'api-key',
    extraQuery: 'api-version=2024-10-21',
    hint: 'Key 走 api-key 头；地址填到部署名那一层，模型名填部署名',
    models: []
  },
  {
    id: 'siliconflow',
    keyHint: 'sk-…',
    keyPattern: '^sk-',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    modelHint: 'deepseek-ai/DeepSeek-V3',
    label: 'SiliconFlow 硅基流动',
    wire: 'openai',
    defaultBase: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    hint: '国内中转，模型名带组织前缀',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct']
  },
  {
    id: 'custom',
    keyHint: '按你的服务商而定',
    keyPattern: '',
    keyUrl: '',
    modelHint: '按你的服务商而定',
    label: '自定义 · 任意 OpenAI 兼容端点',
    wire: 'openai',
    defaultBase: '',
    defaultModel: '',
    hint: '任何提供 /chat/completions 的服务；中转站、自建网关都填这里',
    models: []
  },
  {
    id: 'openrouter-free',
    extraHeaders: { 'HTTP-Referer': 'https://github.com/just-translate', 'X-Title': 'Just Translate' },
    keyHint: 'sk-or-v1-…',
    keyPattern: '^sk-or-',
    keyUrl: 'https://openrouter.ai/keys',
    modelHint: '带 :free 后缀的模型',
    label: 'OpenRouter · 免费档',
    wire: 'openai',
    defaultBase: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    hint: '选带 :free 后缀的模型。限流严格，免费额度通常允许用数据训练，内部文档慎用',
    models: []
  },
  {
    id: 'ollama',
    requiresKey: false,
    keyHint: '本地服务不需要 Key，留空即可',
    keyPattern: '',
    keyUrl: '',
    modelHint: '先 ollama pull，再点拉取模型',
    label: '本地 · Ollama / LM Studio',
    wire: 'openai',
    defaultBase: 'http://localhost:11434/v1',
    defaultModel: '',
    hint: '完全免费，数据不出机器。小模型对 JSON 输出合同遵守度较差，对齐失败会更频繁',
    models: []
  }
]);

export function listProviders() {
  return PROVIDER_PRESETS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    defaultBase: provider.defaultBase,
    defaultModel: provider.defaultModel,
    hint: provider.hint,
    auth: provider.auth || 'bearer',
    requiresKey: provider.requiresKey !== false,
    keyHint: provider.keyHint || '',
    extraHeaders: provider.extraHeaders || null,
    keyPattern: provider.keyPattern || '',
    keyUrl: provider.keyUrl || '',
    modelHint: provider.modelHint || '',
    models: [...(provider.models || [])]
  }));
}
