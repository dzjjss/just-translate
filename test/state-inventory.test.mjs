import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../scripts/state-inventory.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('../docs/state-baseline-v0.17.7.json', import.meta.url), 'utf8'));
const key = row => `${row.file}:${row.owner}:${row.name}`;
const allowed = new Map(baseline.map(row => [key(row), row]));
const current = inventory();
for (const row of current) {
  const known = allowed.get(key(row));
  assert.ok(known, `新增状态需要登记所有者与生命周期：${key(row)}`);
  assert.equal(row.lifetime, known.lifetime, `状态生命周期变化：${key(row)}`);
  for (const field of row.fields) assert.ok(known.fields.includes(field), `新增状态字段：${key(row)}.${field}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-state-fixture-'));
try {
  fs.mkdirSync(path.join(scratch, 'src'));
  fs.writeFileSync(path.join(scratch, 'src', 'fixture.js'), `
    const index = new WeakMap();
    let counter = 0;
    const totals = { done: 0, failed: 0 };
    export function record(item) { index.set(item, true); counter++; totals.done++; }
    export function createState() { const values = new Map(); let active = true;
      return { stop() { active = false; values.clear(); }, isActive: () => active }; }
    const LABELS = new Set(['read-only']); export const label = v => LABELS.has(v);
  `);
  const rows = inventory(scratch);
  assert.ok(rows.some(row => row.name === 'index' && row.kind === 'WeakMap'));
  assert.ok(rows.some(row => row.name === 'active' && row.owner === 'createState'));
  assert.ok(rows.some(row => row.name === 'values' && row.kind === 'Map'));
  assert.deepEqual(rows.find(row => row.name === 'totals').fields, ['done', 'failed']);
  assert.ok(!rows.some(row => row.name === 'LABELS'));
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

console.log('状态清单', JSON.stringify(Object.fromEntries(['retained', 'request-or-scan', 'schema', 'schema-write']
  .map(lifetime => {
    const rows = current.filter(row => row.lifetime === lifetime);
    return [lifetime, { definitions: rows.length, fields: rows.reduce((n, row) => n + row.fields.length, 0) }];
  }))));
console.log('2 个用例全部通过（状态增长门禁与检测夹具）');
