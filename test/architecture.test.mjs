/**
 * 架构边界测试。
 *
 * 目录分开但依赖可以随便穿透，不叫模块化。这里把 v0.10.0 建立的几条单向边界
 * 变成机械约束：以后重构如果又把调度状态塞回 main、让 popup 直接 import background，
 * CI 会先于代码审查报错。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

function localImports(file) {
  const text = source(file);
  const out = [];
  const re = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    if (!m[1].startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(file), m[1]);
    out.push(resolved.endsWith('.js') ? resolved : `${resolved}.js`);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

const files = walk(SRC);
const graph = new Map(files.map((file) => [file, localImports(file).filter((p) => files.includes(p))]));

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('依赖方向：shared / prompt / content / popup 不得反向穿透 background', () => {
  const forbidden = [];
  for (const file of files) {
    const r = rel(file);
    const owner = r.split('/')[1];
    for (const dep of graph.get(file) || []) {
      const d = rel(dep);
      if (owner === 'shared' && /src\/(background|content|popup|prompt)\//.test(d)) forbidden.push(`${r} -> ${d}`);
      if (owner === 'prompt' && /src\/(background|content|popup)\//.test(d)) forbidden.push(`${r} -> ${d}`);
      if (owner === 'content' && /src\/(background|popup)\//.test(d)) forbidden.push(`${r} -> ${d}`);
      if (owner === 'popup' && /src\/(background|content)\//.test(d)) forbidden.push(`${r} -> ${d}`);
      if (owner === 'background' && /src\/(content|popup)\//.test(d)) forbidden.push(`${r} -> ${d}`);
    }
  }
  assert.deepEqual(forbidden, [], `发现跨层 import:\n${forbidden.join('\n')}`);
});

test('源码 import graph 不得出现循环依赖', () => {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  let cycle = null;

  const dfs = (file) => {
    if (cycle || visited.has(file)) return;
    if (visiting.has(file)) {
      const i = stack.indexOf(file);
      cycle = [...stack.slice(i), file].map(rel);
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const dep of graph.get(file) || []) dfs(dep);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) dfs(file);
  assert.equal(cycle, null, cycle ? `循环依赖：${cycle.join(' -> ')}` : '');
});

test('main.js 不再拥有 Scheduler 的内部状态', () => {
  const main = source(path.join(SRC, 'content/main.js'));
  for (const token of ['let pending', 'let inflight', 'firstBatchDone', 'drainPromise']) {
    assert.ok(!main.includes(token), `main.js 又开始管理调度内部字段：${token}`);
  }
  assert.ok(!/\bstate\s*\.\s*(pending|inflight|firstBatchDone|gate|glossary|profile)/.test(main));
});

test('main.js 不得直接改 PageSession 的核心字段', () => {
  const main = source(path.join(SRC, 'content/main.js'));
  const directWrite = /\b(?:page|session)\.(?:total|done|failed|profile|glossary|tokens|bypassCache|drift|errorStreak|trail|elUnits)\s*(?:=|\+\+|--|\+=|-=)/g;
  assert.deepEqual([...main.matchAll(directWrite)].map((m) => m[0]), []);
});



test('悬浮球入口必须由 manifest 静态注入，不能再依赖 activeTab / 动态常驻开关', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts || [];
  const entry = scripts.find((x) => (x.js || []).includes('src/content/loader.js'));
  assert.ok(entry, 'manifest 没有静态注入 loader.js，悬浮球在新页面不会自举');
  assert.ok((entry.matches || []).includes('http://*/*'));
  assert.ok((entry.matches || []).includes('https://*/*'));
  assert.ok(!fs.existsSync(path.join(SRC, 'background/always-on.js')), '动态 always-on 模块不该继续和静态注入并存');
});

test('内容脚本自己的偏好写回不得被 PANEL_ONLY 拦截', () => {
  const router = source(path.join(SRC, 'background/router.js'));
  const block = router.match(/const PANEL_ONLY = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.ok(!block.includes('MSG.SAVE_FAB_OFFSET'), '拖动位置写回被错误限制为 panel-only');
  assert.ok(!block.includes('MSG.SAVE_DISPLAY_MODE'), '页面显示模式写回被错误限制为 panel-only');
});

test('语义一致性观测不得恢复裸词 canonical replacement', () => {
  const main = source(path.join(SRC, 'content/main.js'));
  const telemetry = source(path.join(SRC, 'content/term-consistency.js'));
  assert.ok(main.includes('createTermTelemetry'));
  assert.ok(!main.includes('createAlignedTermState'));
  assert.ok(!main.includes('alignedTerms.apply'));
  assert.ok(!telemetry.includes('text.split(actual).join(preferred)'), '语义一致性观测又开始本地替换译文');
});

test('popup 的语义一致性观测位于主层级，默认功能保留数据复制入口', () => {
  const html = fs.readFileSync(path.join(SRC, 'popup/popup.html'), 'utf8');
  assert.ok(html.includes('id="semanticConsistency"'));
  assert.ok(html.includes('语义一致性观测'));
  assert.ok(html.includes('id="copyConsistency"'));
  const homeStart = html.indexOf('id="homeView"');
  const settingsStart = html.indexOf('id="settingsView"');
  const pos = html.indexOf('id="consistencyCard"');
  assert.ok(pos > homeStart && pos < settingsStart, '语义一致性观测必须直接位于首页，而不是设置视图里');
});


test('预检快照默认跨重翻复用，只有显式重新读取才 force 刷新', () => {
  const main = source(path.join(SRC, 'content/main.js'));
  assert.ok(main.includes("if (!force && app.preflightSnapshot?.url === url)"), '普通重翻没有复用同 URL 预检快照');
  assert.ok(main.includes("preflight(page, { force: true })"), '显式重新读取没有 bypass 快照');
  assert.ok(main.includes('preflightHash'), '页面状态没有暴露预检 hash，A/B 无法核对规则集是否一致');
});

test('popup 采用首页 + 一级设置 Tab，不允许重新长成折叠迷宫', () => {
  const html = fs.readFileSync(path.join(SRC, 'popup/popup.html'), 'utf8');
  assert.ok(html.includes('id="homeView"'));
  assert.ok(html.includes('id="settingsView"'));
  for (const tab of ['model', 'style', 'rules', 'tools']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `缺少 ${tab} 一级设置 Tab`);
    assert.ok(html.includes(`data-panel="${tab}"`), `缺少 ${tab} 设置面板`);
  }
  assert.ok(!html.includes('details class="group fold'), '设置重新退化成多层折叠菜单');
  assert.ok(html.includes('id="displaySegments"'), '高频显示方式没有提升为三段式切换');
});

test('popup 设置生命周期：普通开关即时保存，只有模型与规则保留事务应用', () => {
  const html = fs.readFileSync(path.join(SRC, 'popup/popup.html'), 'utf8');
  const popup = source(path.join(SRC, 'popup/popup.js'));
  assert.ok(!html.includes('id="applyAll"'), '不应恢复全局应用按钮');
  assert.ok(html.includes('id="applyModel"'));
  assert.ok(html.includes('id="applyRules"'));
  assert.ok(popup.includes('saveLivePatch'));
  assert.ok(popup.includes('LIVE_BOOL_FIELDS'));
  assert.ok(html.includes('id="wholePageTranslation"'));
  assert.ok(html.includes('优先整页翻译'));
  assert.ok(html.includes('不同模型限制不同'));
  assert.ok(html.includes('超限自动分块'));
  assert.ok(html.includes('id="copyApiKey"'), 'API Key 缺少显式复制按钮');
  assert.ok(html.includes('id="semanticPrecedent"'));
  assert.ok(html.includes('Beta：跨批先例注入'));
  assert.ok(popup.includes("markDirty('model')"));
  assert.ok(popup.includes("markDirty('rules')"));
});

test('模型草稿测试走 panel-only 白名单 override，不必先污染 active 配置', () => {
  const router = source(path.join(SRC, 'background/router.js'));
  assert.ok(router.includes('settingsWithPanelOverride'));
  for (const key of ['providerId', 'apiBase', 'apiKey', 'model']) assert.ok(router.includes(`'${key}'`));
  assert.ok(router.includes('payload.settingsOverride'));
});

test('popup 的 provider 元数据来自 shared catalog，不依赖后台网络实现', () => {
  const popup = source(path.join(SRC, 'popup/popup.js'));
  assert.ok(popup.includes("../shared/provider-catalog.js"));
  assert.ok(!popup.includes('../background/providers/'));
});

test('译文字体增强保持单层阴影，不退回高开销描边', () => {
  const css = fs.readFileSync(path.join(ROOT, 'assets/content.css'), 'utf8');
  const renderer = source(path.join(SRC, 'content/renderer.js'));
  assert.ok(css.includes(".byom-t[data-byom-state='done']"), '字体增强没有限制在完成态译文');
  assert.ok(css.includes('var(--byom-text-shadow, none)'), '译文没有使用主题感知阴影变量');
  assert.ok(css.includes('(forced-colors: active)'), '强制配色下没有关闭字体阴影');
  assert.ok(!/(?:-webkit-)?text-stroke\s*:/.test(css), '重新引入了会改变中文字重的 text-stroke');
  assert.ok(renderer.includes("dark ? '0 0 0.45px rgba(0, 0, 0, 0.38)'"));
  assert.ok(renderer.includes("'0 0 0.4px rgba(255, 255, 255, 0.28)'"));
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
