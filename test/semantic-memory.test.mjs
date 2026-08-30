import assert from 'node:assert';
import { contextTrigger, createSemanticMemory } from '../src/content/semantic-memory.js';

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const power = { term: 'power', lemma: 'power', kind: 'lexical' };

test('context trigger 会把 battery power 与 Power Mode 分成不同作用域', () => {
  const a = contextTrigger('Wi-Fi uses less battery power than cellular networks.', 'power');
  const b = contextTrigger('Open Settings, tap Battery, and then tap Power Mode.', 'Power');
  assert.ok(a.includes('battery power'));
  assert.ok(b.includes('power mode'));
  assert.notEqual(a, b);
});

test('同一局部 trigger 再次出现时才给 scoped hint', () => {
  const memory = createSemanticMemory();
  memory.observe({
    unit: { text: 'Wi-Fi uses less battery power than cellular networks.' },
    translation: 'Wi-Fi 比蜂窝网络消耗更少的电池电量。',
    alignments: { power: '电量' },
    candidates: [power]
  });
  const hit = memory.hintsFor(
    [{ text: 'Wi-Fi uses less battery power than cellular networks.' }],
    [power]
  );
  assert.equal(hit.length, 1);
  assert.equal(hit[0].target, '电量');

  const miss = memory.hintsFor(
    [{ text: 'Open Settings and tap Power Mode.' }],
    [{ ...power, term: 'Power' }]
  );
  assert.equal(miss.length, 0, '裸词相同不该把电量泛化到 Power Mode');
});

test('同一 trigger 自己出现多译时熔断，不选择 first-wins canonical', () => {
  const memory = createSemanticMemory();
  const unit = { text: 'Wi-Fi uses less battery power than cellular networks.' };
  memory.observe({ unit, translation: '电池电量较低。', alignments: { power: '电量' }, candidates: [power] });
  memory.observe({ unit, translation: '电池功耗较低。', alignments: { power: '功耗' }, candidates: [power] });
  assert.equal(memory.hintsFor([unit], [power]).length, 0);
  assert.equal(memory.snapshot().conflictedContextualEntries, 1);
});


test('排版引号差异不会让同一 contextual trigger 误熔断，并记录 hint provenance', () => {
  const memory = createSemanticMemory();
  const settings = { term: 'Settings', lemma: 'settings', kind: 'lexical' };
  const unit = { text: 'Open Settings and tap Battery.' };
  memory.observe({ unit, translation: '打开“设置”并轻点电池。', alignments: { Settings: '“设置”' }, candidates: [settings] });
  memory.observe({ unit, translation: '打开设置并轻点电池。', alignments: { Settings: '设置' }, candidates: [settings] });
  const hints = memory.hintsFor([unit], [settings]);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].normalizedTarget, '设置');
  assert.equal(hints[0].provenance, 'SESSION_CONTEXTUAL_PRECEDENT');
  const stats = memory.stats();
  assert.equal(stats.conflictedContextualEntries, 0);
  assert.equal(stats.hintHits, 1);
});

test('先例命中后记录实际输出是否匹配，但不声称存在因果影响', () => {
  const memory = createSemanticMemory();
  const unit = { text: 'Wi-Fi uses less battery power than cellular networks.' };
  memory.observe({ unit, translation: '电池电量较低。', alignments: { power: '电量' }, candidates: [power] });
  const hints = memory.hintsFor([unit], [power]);

  memory.recordHintOutcomes({ unit, translation: '电池电量较低。', alignments: { power: '电量' }, hints });
  memory.recordHintOutcomes({ unit, translation: '电池功耗较低。', alignments: { power: '功耗' }, hints });
  memory.recordHintOutcomes({ unit, translation: '电池表现较低。', alignments: {}, hints });

  const stats = memory.stats();
  assert.equal(stats.precedentOutcomes, 3);
  assert.equal(stats.precedentMatched, 1);
  assert.equal(stats.precedentDiverged, 1);
  assert.equal(stats.precedentUnaligned, 1);
  assert.equal(stats.precedentMatchRate, 0.5);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.stack || e.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
