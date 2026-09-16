/** Ratchet existing hotspots; new functions must stay at classic CC <= 20. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const linter = new Linter();
const scores = [];
const coreScores = {};
let lines = 0;
for (const file of walk(path.join(root, 'src')).filter(file => file.endsWith('.js'))) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  lines += source.trimEnd().split('\n').length;
  const messages = linter.verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { complexity: ['error', { max: 0, variant: 'classic' }] }
  });
  for (const message of messages) {
    assert.ok(!message.fatal, `${relative}: ${message.message}`);
    const match = message.message.match(/^(.*?) has a complexity of (\d+)/);
    assert.ok(match, message.message);
    const [, label, number] = match;
    const score = Number(number);
    scores.push(score);
    if (/function '(sendChunk|translateChunk|preflight)'/i.test(label)) coreScores[label] = score;
    assert.ok(score <= 20, `Complexity hotspot: ${relative}|${label} = ${score}`);
  }
  if (relative !== 'src/content/session.js') {
    assert.doesNotMatch(source, /\bunit\.state\s*=(?!=)/, `Unit state must be owned by session: ${relative}`);
  }
  if (relative === 'src/content/main.js') {
    assert.doesNotMatch(source, /app\.running\s*=(?!=)|\.markDone\(|\.markFailed\(/);
  }
}
scores.sort((a, b) => a - b);
console.log('复杂度基线', JSON.stringify({
  jsLines: lines, functions: scores.length,
  p90: scores[Math.ceil(scores.length * .9) - 1],
  p95: scores[Math.ceil(scores.length * .95) - 1],
  max: scores.at(-1), over20: scores.filter(score => score > 20).length, coreScores
}));
console.log('1 个用例全部通过（复杂度门禁与状态所有权）');
