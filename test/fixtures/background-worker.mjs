// Real module startup in an isolated JS worker; Chrome storage and HTTP are fixtures.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

const stored = workerData;
let requests = 0;
let listener;
const event = () => ({ addListener() {} });
globalThis.chrome = {
  runtime: { onMessage: { addListener(fn) { listener = fn; } }, onSuspend: event(),
    getManifest: () => manifest },
  storage: { local: {
    async get(key) { return structuredClone({ [key]: stored[key] }); },
    async set(value) { Object.assign(stored, structuredClone(value)); },
    async remove(key) { delete stored[key]; },
    async setAccessLevel() {}
  }, session: {
    // storage.session 在真实 Chrome 里跨 worker 回收存活，这里用同一份持久化对象建模。
    async get(key) { return structuredClone({ [key]: stored[key] }); },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  }, onChanged: event() },
  permissions: { async contains() { return true; }, onRemoved: event() },
  commands: { onCommand: event() },
  tabs: { onRemoved: event(), onUpdated: event(), async query() { return []; } }
};
globalThis.fetch = async (_url, init) => {
  requests++;
  const body = JSON.parse(init.body);
  const user = body.messages[1].content;
  const ids = [...user.matchAll(/^\s+i: (\d+)$/gm)].map(match => Number(match[1]));
  const content = ids.length
    ? JSON.stringify({ items: ids.map(i => ({ i, t: `Translated passage ${i}.` })) })
    : '领域: battery support\n优先:\n  电池健康: Battery Health';
  return new Response(JSON.stringify({ choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 } }));
};
await import('../../src/background/service-worker.js');
parentPort.on('message', ({ id, message, sender }) => {
  listener(message, sender, response => parentPort.postMessage({ id, response, stored, requests }));
});
