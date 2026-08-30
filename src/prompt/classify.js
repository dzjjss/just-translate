import { PRESET_IDS } from './presets.js';

/**
 * 页面分类完全本地完成：零 token、零延迟。
 * 顺序：站点规则 > 域名表 > 页面结构特征 > general。
 */

const HOST_TABLE = [
  [
    'academic',
    [
      'arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'jstor.org', 'nature.com',
      'science.org', 'sciencedirect.com', 'springer.com', 'wiley.com', 'tandfonline.com',
      'acm.org', 'ieee.org', 'pubmed.ncbi.nlm.nih.gov', 'doi.org', 'semanticscholar.org',
      'researchgate.net', 'plos.org', 'mdpi.com', 'openreview.net', '.edu'
    ]
  ],
  [
    'technical',
    [
      'github.com', 'gitlab.com', 'stackoverflow.com', 'stackexchange.com', 'readthedocs.io',
      'developer.mozilla.org', 'npmjs.com', 'pypi.org', 'crates.io', 'rust-lang.org',
      'kernel.org', 'man7.org', 'learn.microsoft.com', 'docs.', 'developer.', 'devblogs.',
      'cisco.com', 'juniper.net', 'kubernetes.io', 'docker.com', 'postgresql.org', 'redis.io',
      'nginx.org', 'openwrt.org', 'wiki.archlinux.org', 'godbolt.org', 'huggingface.co'
    ]
  ],
  [
    'forum',
    [
      'reddit.com', 'news.ycombinator.com', 'lobste.rs', 'v2ex.com', 'discourse.',
      'forum.', 'bbs.', 'quora.com', 'zhihu.com', 'tildes.net', 'hackernews'
    ]
  ],
  [
    'news',
    [
      'nytimes.com', 'wsj.com', 'bbc.', 'reuters.com', 'apnews.com', 'theguardian.com',
      'bloomberg.com', 'ft.com', 'economist.com', 'cnn.com', 'npr.org', 'cbc.ca',
      'theglobeandmail.com', 'aljazeera.com', 'politico.com', 'axios.com', 'theverge.com',
      'arstechnica.com', 'techcrunch.com'
    ]
  ]
];

const ACADEMIC_HEADINGS = ['abstract', 'introduction', 'related work', 'methodology',
  'references', 'bibliography', 'conclusion', 'acknowledg', '摘要', '参考文献'];

export function classifyPage(ctx = {}, siteRules = []) {
  const host = String(ctx.hostname || '').toLowerCase();

  for (const rule of siteRules) {
    if (!rule || !rule.host || !PRESET_IDS.includes(rule.presetId)) continue;
    if (host === rule.host.toLowerCase() || host.endsWith('.' + rule.host.toLowerCase())) {
      return { presetId: rule.presetId, reason: 'site-rule' };
    }
  }

  for (const [presetId, patterns] of HOST_TABLE) {
    if (patterns.some((p) => host.includes(p))) return { presetId, reason: 'host' };
  }

  const headings = (ctx.headings || []).join(' ').toLowerCase();
  const academicHits = ACADEMIC_HEADINGS.filter((h) => headings.includes(h)).length;
  if (academicHits >= 2) return { presetId: 'academic', reason: 'structure' };
  if (ctx.codeBlocks >= 3) return { presetId: 'technical', reason: 'structure' };
  if (ctx.ogType === 'article' && ctx.hasByline) return { presetId: 'news', reason: 'structure' };
  if (ctx.commentNodes >= 8) return { presetId: 'forum', reason: 'structure' };

  return { presetId: 'general', reason: 'fallback' };
}
