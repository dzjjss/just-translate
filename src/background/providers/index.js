import { openaiWire } from './openai.js';
import { anthropicWire } from './anthropic.js';
import { googleTranslateWire } from './google-translate.js';
import { deepLXWire } from './deeplx.js';
import { PROVIDER_PRESETS, listProviders } from '../../shared/provider-catalog.js';

/**
 * 网络实现只留在 background；provider 的静态 catalog 在 shared，供 popup 安全复用。
 */
const WIRES = {
  openai: openaiWire,
  anthropic: anthropicWire,
  'google-translate': googleTranslateWire,
  deeplx: deepLXWire
};

const BY_ID = new Map(PROVIDER_PRESETS.map((provider) => [provider.id, provider]));

export function getProvider(id) {
  return BY_ID.get(id) || PROVIDER_PRESETS[0];
}

export function wireFor(provider) {
  return WIRES[provider.wire] || openaiWire;
}

// 兼容已有后台调用；popup 应直接从 shared/provider-catalog.js 读取。
export { listProviders };
