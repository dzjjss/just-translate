import assert from 'node:assert';
import {
  createTermTelemetry,
  extractRepeatedSourceTerms,
  isHighConfidenceFixedForm,
  normalizeRenderedForComparison,
  matchTrackedTermRows,
  matchTrackedTerms
} from '../src/content/term-consistency.js';
import { buildMessages, parseTranslationResponse, promptFingerprint } from '../src/prompt/build.js';

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('格式只认内部大小写/混合数字为高置信 identifier；普通 ALL CAPS 不再直接 FIXED', () => {
  for (const x of ['Learn', 'Open', 'Check', 'Use', 'Charge', 'Enable', 'Low', 'Power', 'Mode', 'Usage', 'Ogilvy']) {
    assert.equal(isHighConfidenceFixedForm(x), false, `${x} 不应仅因首字母大写成为 FIXED`);
  }
  for (const x of ['iPhone', 'iPadOS', 'iOS', 'Wi-Fi', 'H264', '5G']) {
    assert.equal(isHighConfidenceFixedForm(x), true, `${x} 应保留高置信 identifier 信号`);
  }
  for (const x of ['LTE', 'HTTP', 'API', 'BOOK', 'COMMON']) {
    assert.equal(isHighConfidenceFixedForm(x), false, `${x} 不能只靠 ALL CAPS 获得 FIXED 权限`);
  }
});

test('Apple 式标题不会污染 FIXED；tap 等短重复实词不再被长度阈值漏掉', () => {
  const units = [
    { role: 'body', text: 'Learn about Insights. Open Settings and tap Battery. Use Low Power Mode on iPhone with iPadOS and LTE over Wi-Fi.' },
    { role: 'body', text: 'Learn more. Open Settings, then tap Battery. Use Low Power Mode on iPhone. iPadOS supports LTE and Wi-Fi.' }
  ];
  const terms = extractRepeatedSourceTerms(units, { maxTerms: 100 });
  const byLemma = new Map(terms.map((x) => [x.lemma, x]));

  for (const x of ['learn', 'open', 'use', 'low', 'power', 'mode', 'settings', 'battery', 'tap', 'lte']) {
    assert.equal(byLemma.get(x)?.kind, 'lexical', `${x} 应作为 lexical 观测，而不是 FIXED/漏掉`);
  }
  for (const x of ['iPhone', 'iPadOS', 'Wi-Fi']) {
    assert.equal(terms.find((r) => r.term === x)?.kind, 'fixed', `${x} 应作为高置信 identifier 候选`);
  }
});

test('人称代词缩写属于停用词，不进入多义一致性候选', () => {
  const terms = extractRepeatedSourceTerms([
    { role: 'body', text: "You'll see it when you're ready. We'll wait." },
    { role: 'body', text: "You'll know when you're done. We'll leave." }
  ], { maxTerms: 100 });
  const lemmas = new Set(terms.map((row) => row.lemma));
  for (const token of ["you'll", "you're", "we'll"]) {
    assert.equal(lemmas.has(token), false, `${token} 不应进入语义一致性候选`);
  }
});

test('小说全大写标题词与罗马数字只归 STRUCTURAL，不进入术语 FIXED', () => {
  const units = [
    { role: 'heading', text: 'BOOK ONE THE COMING OF THE MARTIANS' },
    { role: 'heading', text: 'BOOK TWO THE EARTH UNDER THE MARTIANS' },
    { role: 'heading', text: 'VIII. FRIDAY NIGHT.' },
    { role: 'body', text: 'VIII. DEAD LONDON.' },
    { role: 'body', text: 'The book lay open on the table.' },
    { role: 'body', text: 'Another book was nearby.' }
  ];
  const terms = extractRepeatedSourceTerms(units, { maxTerms: 100 });
  const book = terms.find((x) => x.lemma === 'book');
  const viii = terms.find((x) => x.lemma === 'viii');
  assert.equal(book?.kind, 'lexical', '正文里的 book 应压过标题排版，不能被 BOOK 劫持');
  assert.equal(viii?.kind, 'structural', '即使 DOM 没标 heading，全大写短标题里的章节号也应作为 STRUCTURAL');
});

test('普通大小写变化共享 lemma，但保留真实 surface 与语境证据', () => {
  const units = [
    { text: 'Ongoing iOS Update.' },
    { text: "Some update tasks are still ongoing while iOS finishes." },
    { text: 'They crossed the Common before sunset.' },
    { text: 'A common belief spread through the town.' }
  ];
  const terms = extractRepeatedSourceTerms(units, { maxTerms: 100 });
  const ongoing = terms.find((x) => x.lemma === 'ongoing');
  const common = terms.find((x) => x.lemma === 'common');
  assert.ok(ongoing && common);
  assert.equal(ongoing.kind, 'lexical');
  assert.equal(common.kind, 'lexical');
  assert.deepEqual(new Set(ongoing.surfaces.map((x) => x.surface)), new Set(['Ongoing', 'ongoing']));
  assert.deepEqual(new Set(common.surfaces.map((x) => x.surface)), new Set(['Common', 'common']));
});

test('Ogilvy 不靠大写被宣布成专名；只作为 lexical 观测等待分布证据', () => {
  const units = [
    { text: 'Ogilvy watched the projectile cross the sky.' },
    { text: 'The projectile was still invisible to Ogilvy.' }
  ];
  const terms = extractRepeatedSourceTerms(units, { maxTerms: 30 });
  const ogilvy = terms.find((x) => x.lemma === 'ogilvy');
  const projectile = terms.find((x) => x.lemma === 'projectile');
  assert.equal(ogilvy?.kind, 'lexical');
  assert.equal(projectile?.kind, 'lexical');
});

test('每批发送当前真实 surface；lexical identity 仍按 lemma 合并', () => {
  const candidates = extractRepeatedSourceTerms([
    { text: 'Ongoing iOS Update. They crossed the Common.' },
    { text: 'The tasks are ongoing. This is a common belief.' }
  ], { maxTerms: 50 });

  const rows = matchTrackedTermRows(candidates, [{ text: 'The tasks are ongoing. This is a common belief.' }], { maxTerms: 50 });
  assert.ok(rows.some((x) => x.term === 'ongoing' && x.lemma === 'ongoing'));
  assert.ok(rows.some((x) => x.term === 'common' && x.lemma === 'common'));
  assert.deepEqual(
    matchTrackedTerms(candidates, [{ text: 'The tasks are ongoing. This is a common belief.' }], { maxTerms: 50 }),
    rows.map((x) => x.term)
  );
});

test('显式 locked 与自动候选同名时只发送 locked 一份', () => {
  const rows = matchTrackedTermRows([
    { term: 'Ogilvy', lemma: 'ogilvy', kind: 'locked' },
    { term: 'Ogilvy', lemma: 'ogilvy', kind: 'lexical', surfaces: [{ surface: 'Ogilvy', count: 2 }] }
  ], [{ text: 'Ogilvy watched.' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'locked');
});

test('普通词单一译法只标 STABLE，不凭格式猜 FIXED/POLYSEMOUS', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'projectile', lemma: 'projectile', kind: 'lexical' }];
  telemetry.record({
    unit: { id: 1, text: 'The projectile crossed the sky.' },
    translation: '发射物划过天空。',
    alignments: { projectile: '发射物' },
    candidates: candidate
  });
  const row = telemetry.snapshot().rows[0];
  assert.equal(row.taxonomy, 'STABLE');
  assert.equal(row.consistency, 'CONSISTENT');
});

test('普通词出现多译时统一留在 UNKNOWN，不用词形规则猜语义', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'projectile', lemma: 'projectile', kind: 'lexical' }];
  telemetry.record({
    unit: { id: 1, text: 'The projectile crossed the sky.' },
    translation: '发射物划过天空。',
    alignments: { projectile: '发射物' },
    candidates: candidate
  });
  telemetry.record({
    unit: { id: 2, text: 'Another projectile followed.' },
    translation: '另一枚炮弹紧随其后。',
    alignments: { projectile: '炮弹' },
    candidates: candidate
  });

  const snap = telemetry.snapshot();
  assert.equal(snap.summary.contextual, 0, '旧字段保留但新 taxonomy 不再产出 CONTEXTUAL');
  assert.equal(snap.summary.fixedDrift, 0);
  assert.equal(snap.summary.unknown, 1);
  assert.equal(snap.rows[0].taxonomy, 'UNKNOWN');
  assert.deepEqual(snap.rows[0].evidence, ['MULTIPLE_TARGET_VARIANTS']);
});

test('目标侧包含关系不再参与语义分类', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'Learn', lemma: 'learn', kind: 'lexical' }];
  telemetry.record({
    unit: { id: 1, role: 'heading', text: 'Learn about suggestions.' },
    translation: '了解建议。',
    alignments: { Learn: '了解' },
    candidates: candidate
  });
  telemetry.record({
    unit: { id: 2, role: 'heading', text: 'Learn more about Adaptive Power.' },
    translation: '进一步了解自适应电源。',
    alignments: { Learn: '进一步了解' },
    candidates: candidate
  });
  const snap = telemetry.snapshot();
  assert.equal(snap.rows[0].taxonomy, 'UNKNOWN');
  assert.deepEqual(snap.rows[0].evidence, ['MULTIPLE_TARGET_VARIANTS']);
  assert.equal(snap.summary.compositional, 0, '旧字段保留但新 taxonomy 不再产出 COMPOSITIONAL');
});

test('即使候选携带旧 source containment 元数据，也不再确认 COMPOSITIONAL', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{
    term: 'Learn', lemma: 'learn', kind: 'lexical',
    sourceSpanRelations: [{ relation: 'CONTAINS', shorter: 'Learn', longer: 'Learn more' }]
  }];
  telemetry.record({ unit: { id: 1, text: 'Learn.' }, translation: '了解。', alignments: { Learn: '了解' }, candidates: candidate });
  telemetry.record({ unit: { id: 2, text: 'Learn more.' }, translation: '进一步了解。', alignments: { Learn: '进一步了解' }, candidates: candidate });
  const row = telemetry.snapshot().rows[0];
  assert.equal(row.taxonomy, 'UNKNOWN');
  assert.deepEqual(row.evidence, ['MULTIPLE_TARGET_VARIANTS']);
});

test('比较时剥掉成对引号，但 raw rendering 仍保留用于回看', () => {
  assert.equal(normalizeRenderedForComparison('“设置”'), '设置');
  assert.equal(normalizeRenderedForComparison('「洞察」'), '洞察');
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'Settings', lemma: 'settings', kind: 'locked' }];
  telemetry.record({ unit: { id: 1, text: 'Open Settings.' }, translation: '打开“设置”。', alignments: { Settings: '“设置”' }, candidates: candidate });
  telemetry.record({ unit: { id: 2, text: 'Return to Settings.' }, translation: '返回设置。', alignments: { Settings: '设置' }, candidates: candidate });
  const row = telemetry.snapshot().rows[0];
  assert.equal(row.variantCount, 1, '引号差异不能制造 fixed drift');
  assert.equal(row.rawVariantCount, 2, 'raw rendering 应继续保留排版差异');
  assert.equal(row.consistency, 'CONSISTENT');
});

test('Martian 名词位/定语位的不同译法留在 UNKNOWN，而不是规则猜测', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'Martian', lemma: 'martian', kind: 'lexical' }];
  telemetry.record({
    unit: { id: 1, role: 'body', text: 'A Martian approached slowly.' },
    translation: '一个火星人缓慢靠近。',
    alignments: { Martian: '火星人' }, candidates: candidate
  });
  telemetry.record({
    unit: { id: 2, role: 'body', text: 'One of the Martian giants returned.' },
    translation: '一个火星巨人折返回来。',
    alignments: { Martian: '火星' }, candidates: candidate
  });
  const row = telemetry.snapshot().rows[0];
  assert.equal(row.taxonomy, 'UNKNOWN');
  assert.equal(row.consistency, 'UNRESOLVED');
});

test('FIXED 只来自明确 hard 或高置信结构形态；多译才记 fixed drift', () => {
  const telemetry = createTermTelemetry();
  telemetry.record({
    unit: { id: 1, text: 'iPhone uses LTE.' },
    translation: 'iPhone 使用 LTE。',
    alignments: { iPhone: 'iPhone', LTE: 'LTE' },
    candidates: [{ term: 'iPhone', kind: 'fixed' }, { term: 'LTE', kind: 'fixed' }]
  });
  telemetry.record({
    unit: { id: 2, text: 'iPhone supports LTE.' },
    translation: '苹果手机支持 LTE。',
    alignments: { iPhone: '苹果手机', LTE: 'LTE' },
    candidates: [{ term: 'iPhone', kind: 'fixed' }, { term: 'LTE', kind: 'fixed' }]
  });
  const snap = telemetry.snapshot();
  const iphone = snap.rows.find((x) => x.source === 'iPhone');
  assert.equal(iphone.taxonomy, 'FIXED');
  assert.equal(iphone.consistency, 'DRIFT');
  assert.equal(snap.summary.fixedDrift, 1);
});

test('telemetry 保留 occurrence 的真实大小写与局部上下文，为后续 sense 判断提供证据', () => {
  const telemetry = createTermTelemetry();
  const candidate = [{ term: 'ongoing', lemma: 'ongoing', kind: 'lexical' }];
  telemetry.record({
    unit: { id: 7, text: 'Certain tasks related to the update are still ongoing in the background.' },
    translation: '与更新相关的某些任务仍在后台持续进行。',
    alignments: { ongoing: '持续进行' },
    candidates: candidate
  });
  const row = telemetry.snapshot().rows[0];
  assert.equal(row.samples[0].sourceSurface, 'ongoing');
  assert.equal(row.samples[0].sourceRoleShape, null, 'v2 字段保留但不再计算');
  assert.ok(row.samples[0].localContext.includes('tasks related to the update'));
  assert.deepEqual(row.sourceSurfaces, [{ surface: 'ongoing', count: 1 }]);
});

test('taxonomy v3 只产生可靠语义类别，并保留旧汇总字段', () => {
  const telemetry = createTermTelemetry();
  telemetry.record({
    unit: { id: 1, text: 'Battery power is low.' }, translation: '电池电量较低。',
    alignments: { power: '电量' }, candidates: [{ term: 'power', kind: 'lexical' }]
  });
  telemetry.record({
    unit: { id: 2, text: 'Power supply is limited.' }, translation: '电源受限。',
    alignments: { Power: '电源' }, candidates: [{ term: 'Power', lemma: 'power', kind: 'lexical' }]
  });
  const snap = telemetry.snapshot();
  assert.equal(snap.summary.taxonomyVersion, 3);
  for (const legacy of ['contextual', 'compositional', 'polysemous', 'stylistic', 'properNameDrift']) {
    assert.equal(snap.summary[legacy], 0, `${legacy} 兼容字段应保留为 0`);
  }
});

test('alignment 缺失只降低候选对齐率，不制造虚假变体', () => {
  const telemetry = createTermTelemetry();
  telemetry.record({
    unit: { id: 1, text: 'The projectile crossed the sky.' },
    translation: '那东西划过天空。',
    alignments: {},
    candidates: [{ term: 'projectile', kind: 'lexical' }]
  });
  const snap = telemetry.snapshot();
  assert.equal(snap.summary.expectedOccurrences, 1);
  assert.equal(snap.summary.alignedOccurrences, 0);
  assert.equal(snap.summary.candidateAlignmentRate, 0);
  assert.equal(snap.rows.length, 0);
});

test('alignment 元数据同时服务 semantic memory 与一致性观测', () => {
  const off = buildMessages({
    items: [{ i: 1, text: 'Ogilvy watched.' }],
    presetId: 'general', targetLang: '简体中文', semanticConsistency: false,
    trackedTerms: ['Ogilvy']
  });
  assert.ok(off.system.includes('SOURCE-TERM ALIGNMENT METADATA'));
  assert.ok(off.user.includes('tracked_terms:'));
  assert.ok(off.user.includes('- "Ogilvy"'));

  const on = buildMessages({
    items: [{ i: 1, text: 'Ogilvy watched.' }],
    presetId: 'general', targetLang: '简体中文', semanticConsistency: true,
    trackedTerms: ['Ogilvy'],
    profile: { hard: { Ogilvy: '奥吉尔维' }, preferred: { projectile: '发射物' } }
  });
  assert.ok(on.system.includes('SOURCE-TERM ALIGNMENT METADATA'));
  assert.ok(on.system.includes('LOCKED TERMS'), '用户 hard 约束仍必须保留');
  assert.ok(on.system.includes('PREFERRED TERMS'), 'preferred 约束仍必须保留');
});

test('semanticConsistency 开关本身不直接进入 promptFingerprint；实际 memory hint 单独入指纹', () => {
  const base = {
    presetId: 'general', customPrompt: '', targetLang: '简体中文', background: '', profile: null
  };
  assert.equal(promptFingerprint(base), promptFingerprint({ ...base, semanticConsistency: true }));
});

test('模型解析同时保留译文与可选 alignment 元数据', () => {
  const out = parseTranslationResponse(
    '{"items":[{"i":1,"t":"奥吉尔维看见了。","a":{"Ogilvy":"奥吉尔维"}}]}',
    [1]
  );
  assert.equal(out.map.get(1), '奥吉尔维看见了。');
  assert.deepEqual(out.alignments.get(1), { Ogilvy: '奥吉尔维' });
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
