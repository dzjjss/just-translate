import assert from 'node:assert';
import {
  classifyDiagnosticError,
  createDiagnosticLog,
  sanitizeDiagnosticUrl,
  sanitizeDiagnosticValue
} from '../src/shared/diagnostics.js';

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('诊断 URL 去掉账号、query、hash 与疑似令牌路径段', () => {
  assert.equal(
    sanitizeDiagnosticUrl('https://alice:secret@example.com/docs/abcdefghijklmnopqrstuvwxyz012345?key=secret#part'),
    'https://example.com/docs/[id]'
  );
  assert.equal(sanitizeDiagnosticUrl('chrome://settings/privacy?x=1'), 'chrome://settings/privacy');
});

test('第三方错误只归类，不需要把可能回显正文的 message 放进诊断包', () => {
  assert.equal(classifyDiagnosticError('触发速率限制，稍后重试', 429), 'rate-limit');
  assert.equal(classifyDiagnosticError('Unauthorized', 401), 'authentication');
  assert.equal(classifyDiagnosticError('模型没有返回可解析的 JSON'), 'invalid-response');
  assert.equal(classifyDiagnosticError('arbitrary server text with private source'), 'unclassified');
});

test('诊断值剔除正文与凭证，同时保留 token 用量数字', () => {
  const safe = sanitizeDiagnosticValue({
    apiKey: 'sk-this-must-not-leak',
    prompt: 'translate private page text',
    body: '{ private response }',
    tokens: { input: 5773, output: 2855 },
    error: 'Authorization: Bearer abcdef; API key=sk-another-secret at https://api.example.com/v1?q=private#x',
    url: 'https://example.com/article?session=secret#comments'
  });
  const json = JSON.stringify(safe);
  assert.ok(!json.includes('this-must-not-leak'));
  assert.ok(!json.includes('private page text'));
  assert.ok(!json.includes('private response'));
  assert.ok(!json.includes('abcdef'));
  assert.ok(!json.includes('another-secret'));
  assert.ok(!json.includes('session=secret'));
  assert.deepEqual(safe.tokens, { input: 5773, output: 2855 });
  assert.equal(safe.url, 'https://example.com/article');
});

test('会话日志保持有界，清空后序号与内容都重新开始', () => {
  let time = 1_700_000_000_000;
  const log = createDiagnosticLog({ limit: 10, now: () => time++ });
  for (let i = 0; i < 12; i++) log.record(`event-${i}`, { index: i });
  const before = log.snapshot();
  assert.equal(before.eventCount, 10);
  assert.equal(before.events[0].event, 'event-2');
  assert.equal(before.events.at(-1).event, 'event-11');

  log.clear();
  assert.equal(log.size, 0);
  log.record('after-clear');
  const after = log.snapshot();
  assert.equal(after.eventCount, 1);
  assert.equal(after.events[0].n, 1);
  assert.equal(after.events[0].event, 'after-clear');
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
