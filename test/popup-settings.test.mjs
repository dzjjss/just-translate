import assert from 'node:assert/strict';
import { createSettingsForm } from '../src/popup/settings-form.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
function setup() {
  const initial = { providerId: 'deepseek', apiBase: 'https://api.deepseek.com', apiKey: 'original',
    model: 'model-a', background: '', rulesText: '', customPrompt: '', configVersion: 1,
    accounts: { openai: { apiBase: 'https://api.openai.com/v1', apiKey: 'other', model: 'model-b' } } };
  const fields = Object.fromEntries(Object.entries(initial).map(([id, value]) => [id, { value }]));
  const pending = [];
  global.chrome = { runtime: { sendMessage(message) {
    return new Promise((resolve, reject) => pending.push({ patch: message.payload.patch, resolve, reject }));
  } } };
  const form = createSettingsForm(id => fields[id], initial);
  const accept = (index, version, snapshot = initial) => {
    const request = pending[index];
    const next = { ...snapshot, ...request.patch, configVersion: version };
    next.accounts = { ...snapshot.accounts, ...request.patch.accounts };
    request.resolve({ ok: true, settings: next });
    return next;
  };
  return { initial, fields, pending, form, accept };
}

test('编辑后撤回原值直接恢复干净状态，无脏标记或保存请求', () => {
  const { fields, form, pending } = setup();
  fields.apiKey.value = 'edit';
  fields.rulesText.value = '领域: Linux';
  assert.equal(form.changed('model'), true);
  assert.equal(form.changed('rules'), true);
  fields.apiKey.value = 'original';
  fields.rulesText.value = '  ';
  assert.equal(form.changed('model'), false);
  assert.equal(form.changed('rules'), false);
  assert.equal(pending.length, 0);
});

test('保存期间的新规则不被旧回执标为已保存', async () => {
  const { fields, form, pending, accept } = setup();
  fields.rulesText.value = '领域: Linux';
  const first = form.applyRules();
  fields.rulesText.value = '领域: Wayland';
  accept(0, 2);
  await first;
  assert.equal(form.changed('rules'), true);
  assert.equal(pending[0].patch.rulesText, '领域: Linux');
  const second = form.applyRules();
  accept(1, 3, form.saved);
  await second;
  assert.equal(form.changed('rules'), false);
  assert.equal(form.saved.rulesText, '领域: Wayland');
});

test('保存中编辑 Key 并切换服务商，回执不能改变草稿归属', async () => {
  const { fields, form, accept } = setup();
  fields.apiKey.value = 'submitted';
  const first = form.applyModel();
  fields.apiKey.value = 'new-draft';
  form.switchProvider('openai');
  fields.apiKey.value = 'openai-draft';
  accept(0, 2);
  await first;
  assert.equal(form.readModel().providerId, 'openai');
  assert.equal(fields.apiKey.value, 'openai-draft');
  form.switchProvider('deepseek');
  assert.equal(fields.apiKey.value, 'new-draft');
  assert.equal(form.changed('model'), true);
  form.switchProvider('openai');
  assert.equal(fields.apiKey.value, 'openai-draft');
});

test('乱序回执不回退已确认版本，不需要第二条保存队列', async () => {
  const { form, fields, pending, accept } = setup();
  fields.rulesText.value = '旧稿';
  const first = form.applyRules();
  fields.rulesText.value = '新稿';
  const second = form.applyRules();
  assert.equal(pending.length, 2, '请求应直接交给后台唯一队列');
  accept(1, 3);
  await second;
  accept(0, 2);
  await first;
  assert.equal(form.saved.configVersion, 3);
  assert.equal(form.saved.rulesText, '新稿');
  assert.equal(form.changed('rules'), false);
});

test('保存失败保留草稿和已确认快照，重试仍能成功', async () => {
  const { form, fields, pending, accept } = setup();
  fields.apiKey.value = 'unsaved';
  const first = form.applyModel();
  pending[0].reject(new Error('channel closed'));
  await assert.rejects(first, /channel closed/);
  assert.equal(form.saved.apiKey, 'original');
  assert.equal(fields.apiKey.value, 'unsaved');
  assert.equal(form.changed('model'), true);
  const retry = form.applyModel();
  accept(1, 2);
  await retry;
  assert.equal(form.changed('model'), false);
});

test('提交仅含改动账户，不回写其他服务商的旧快照', async () => {
  const { form, fields, pending, accept } = setup();
  fields.apiKey.value = 'changed';
  const operation = form.applyModel();
  assert.deepEqual(Object.keys(pending[0].patch.accounts), ['deepseek']);
  accept(0, 2);
  await operation;
  form.switchProvider('openai');
  assert.equal(fields.apiKey.value, 'other');
});

test('未显示的修改仍算草稿，来回切换并撤回后恢复干净', () => {
  const { form, fields } = setup();
  form.switchProvider('openai');
  fields.apiKey.value = 'offscreen';
  form.switchProvider('deepseek');
  assert.equal(form.changed('model'), true);
  form.switchProvider('openai');
  fields.apiKey.value = 'other';
  form.switchProvider('deepseek');
  assert.equal(form.changed('model'), false);
});

for (const [name, fn] of cases) { await fn(); console.log('  ✓', name); }
console.log(`${cases.length} 个用例全部通过`);
