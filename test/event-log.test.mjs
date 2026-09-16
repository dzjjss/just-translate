/**
 * 验收日志本身的约束：串行读写、环形上限、丢弃量如实、脱敏、缺 session 时明确不可用。
 * 这些是取证可信的前提——日志本身丢事件或漏 Key，取来的证据就不能用。
 */
import assert from 'node:assert/strict';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

function makeArea(delay = 0) {
  const data = {};
  return {
    calls: 0,
    async get(key) {
      this.calls++;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return key in data ? structuredClone({ [key]: data[key] }) : {};
    },
    async set(value) { Object.assign(data, structuredClone(value)); }
  };
}

async function loadModule(area, { session = true } = {}) {
  globalThis.chrome = { storage: session ? { session: area, local: makeArea() } : { local: area } };
  // 每个用例要独立的模块实例：写入链是模块级的。
  return import(`../src/background/event-log.js?case=${cases.length}-${Math.random()}`);
}

test('并发记录串行落盘，序号连续且不互相覆盖', async () => {
  const area = makeArea(2);
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  await Promise.all([1, 2, 3, 4, 5].map(i => recordLifecycle('translate-chunk', { i })));
  const snapshot = await lifecycleSnapshot({ epoch: 'e1' });
  assert.deepEqual(snapshot.events.map(row => row.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(snapshot.events.map(row => row.details.i), [1, 2, 3, 4, 5]);
  assert.equal(snapshot.eventCount, 5);
  assert.equal(snapshot.epoch, 'e1');
});

test('超出环形上限丢最旧的，序号继续增长并报告丢弃量', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  for (let i = 0; i < 245; i++) await recordLifecycle('tick', { i });
  const snapshot = await lifecycleSnapshot();
  assert.equal(snapshot.eventCount, 240);
  assert.equal(snapshot.events.at(0).n, 6);
  assert.equal(snapshot.events.at(-1).n, 245);
  assert.equal(snapshot.droppedBefore, 5, '丢弃量必须如实报告，不能假装日志完整');
});

test('Key、请求正文与 URL query 不进日志', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  await recordLifecycle('translate-failed', {
    apiKey: 'sk-secret-value-123456',
    items: ['原文不该出现'],
    endpoint: 'https://api.example.com/v1/chat?token=abc#frag',
    message: 'failed with Bearer sk-another-secret-000000'
  });
  const [row] = (await lifecycleSnapshot()).events;
  const text = JSON.stringify(row);
  assert.ok(!text.includes('sk-secret'), 'apiKey 必须被整键剔除');
  assert.ok(!text.includes('原文不该出现'), 'items 必须被整键剔除');
  assert.ok(!text.includes('token=abc') && !text.includes('#frag'), 'query 与 hash 不得入库');
  assert.equal(row.details.endpoint, 'https://api.example.com/v1/chat');
  assert.ok(row.details.message.includes('[redacted]'));
});

test('清空后保留本次验收的代次起点，且不影响后续记录', async () => {
  const area = makeArea();
  const { recordLifecycle, clearLifecycleLog, lifecycleSnapshot } = await loadModule(area);
  await recordLifecycle('worker-start', { epoch: 'a' });
  assert.equal(await clearLifecycleLog({ epoch: 'a' }), true);
  const [anchor] = (await lifecycleSnapshot()).events;
  assert.equal(anchor.event, 'capture-start');
  assert.equal(anchor.details.epoch, 'a');
  await recordLifecycle('worker-start', { epoch: 'b' });
  const snapshot = await lifecycleSnapshot();
  assert.deepEqual(snapshot.events.map(row => row.n), [1, 2]);
  assert.equal(snapshot.droppedBefore, 0);
});

test('没有 storage.session 时明确不可用，不把临时日志写入 local', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area, { session: false });
  assert.equal(await recordLifecycle('worker-start', { epoch: 'legacy' }), null);
  assert.equal((await lifecycleSnapshot()).unavailable, true);
  assert.deepEqual(await area.get('lifecycleLog'), {});
});

test('读取失败不抛给调用方，也不污染后续写入链', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  const original = area.get;
  area.get = async () => { throw new Error('storage unavailable'); };
  await recordLifecycle('worker-start', { epoch: 'x' });
  area.get = original;
  const setFailure = area.set;
  area.set = async () => { throw new Error('quota'); };
  assert.equal(await recordLifecycle('worker-start', { epoch: 'dropped' }), null, '写入失败只返回 null，不抛给调用方');
  area.set = setFailure;
  await recordLifecycle('worker-start', { epoch: 'y' });
  const snapshot = await lifecycleSnapshot();
  assert.equal(snapshot.events.at(-1).details.epoch, 'y');
  assert.equal(snapshot.writeFailures, 2);
});

test('读取失败不得覆盖已有证据，快照明确标为不可用', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  await recordLifecycle('worker-start', { epoch: 'a' });
  await recordLifecycle('session-open', { session: '7:a' });
  const get = area.get;
  area.get = async () => { throw new Error('temporary read failure'); };
  assert.equal(await recordLifecycle('translate-chunk', { requests: 1 }), null);
  assert.equal((await lifecycleSnapshot()).unavailable, true);
  area.get = get;
  const restored = await lifecycleSnapshot();
  assert.deepEqual(restored.events.map(row => row.event), ['worker-start', 'session-open']);
  assert.equal(restored.writeFailures, 1);
  await recordLifecycle('preflight', { reused: true });
  assert.deepEqual((await lifecycleSnapshot()).events.map(row => row.n), [1, 2, 3]);
});

test('导出等待之前的写入，并在随后清空之前取得快照', async () => {
  const area = makeArea();
  const { recordLifecycle, lifecycleSnapshot, clearLifecycleLog } = await loadModule(area);
  await recordLifecycle('worker-start', { epoch: 'a' });
  const set = area.set;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  area.set = async value => { entered(); await gate; return set.call(area, value); };
  const pending = recordLifecycle('translate-chunk', { requests: 0, wholePageCacheHit: true });
  await started;
  let settled = false;
  const exported = lifecycleSnapshot().then(value => { settled = true; return value; });
  const cleared = clearLifecycleLog({ epoch: 'a' });
  await new Promise(resolve => setTimeout(resolve, 0));
  try { assert.equal(settled, false, '导出不能越过正在写入的事件'); }
  finally { release(); }
  await pending;
  const snapshot = await exported;
  await cleared;
  assert.equal(snapshot.events.at(-1).event, 'translate-chunk');
  assert.equal(snapshot.events.at(-1).details.wholePageCacheHit, true);
  assert.deepEqual((await lifecycleSnapshot()).events.map(row => row.event), ['capture-start']);
});

test('损坏的存储不能伪装为空并被后续记录覆盖', async () => {
  const area = makeArea();
  await area.set({ lifecycleLog: { sequence: 4, events: 'damaged' } });
  const { recordLifecycle, lifecycleSnapshot } = await loadModule(area);
  assert.equal(await recordLifecycle('tick'), null);
  const snapshot = await lifecycleSnapshot();
  assert.equal(snapshot.unavailable, true);
  assert.equal(snapshot.reason, 'invalid-log');
  assert.deepEqual((await area.get('lifecycleLog')).lifecycleLog, { sequence: 4, events: 'damaged' });
});

test('暂时的写入失败在存储恢复后随下一条事件保留，后台模块重启不抹掉缺口', async () => {
  const area = makeArea();
  const first = await loadModule(area);
  await first.recordLifecycle('worker-start', { epoch: 'a' });
  const set = area.set;
  area.set = async () => { throw Error('quota'); };
  assert.equal(await first.recordLifecycle('translate-chunk', { requests: 1 }), null);
  assert.equal(await first.clearLifecycleLog({ epoch: 'a' }), false);
  assert.equal((await first.lifecycleSnapshot()).writeFailures, 1);
  area.set = set;
  await first.recordLifecycle('tick');
  const restarted = await loadModule(area);
  assert.equal((await restarted.lifecycleSnapshot()).writeFailures, 1);
  assert.equal(await restarted.clearLifecycleLog({ epoch: 'b' }), true);
  assert.equal((await restarted.lifecycleSnapshot()).writeFailures, 0);
});

let failures = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('  ✓', name); }
  catch (error) { failures++; console.error('  ✗', name, error); }
}
console.log(failures ? `${failures} 个用例失败` : `${cases.length} 个用例全部通过`);
process.exitCode = failures ? 1 : 0;
