/**
 * 面板集成测试。popup.js 在 v0.3.2 被整体重写（统一暂存 + 单一应用），
 * 而 node --check 只能验证语法，抓不到 ReferenceError、绑错的 id、
 * 事件没接上这类真正会让面板白屏的问题。这里在 jsdom 里连同 popup.html
 * 一起真实加载一遍，并驱动几条关键路径。
 *
 *   npm i -D jsdom && node test/popup.test.mjs
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');

/* ------------------------------ chrome 桩 ------------------------------ */

const sent = [];
let stored = {};
let permissionGranted = true;

const chrome = {
  storage: {
    local: {
      async get(key) {
        return key in stored ? { [key]: stored[key] } : {};
      },
      async set(obj) {
        Object.assign(stored, obj);
      }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    getManifest: () => ({ version: '15.0' }),
    async sendMessage(msg) {
      sent.push(msg);
      if (msg.type === 'preflight-on-tab') {
        return {
          ok: true,
          profile: { domain: ['Wayland'], hard: {}, preferred: { compositor: '合成器' }, risky: { output: '显示输出设备' }, keep: [] },
          profileYaml: '原则: 命令与参数原样保留，不做文学化润色\n领域: Wayland\n优先:\n  compositor: 合成器\n风险词:\n  output: 显示输出设备'
        };
      }
      if (msg.type === 'list-models') return { ok: true, ids: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] };
      if (msg.type === 'get-config') return { ok: true, config: {} };
      if (msg.type === 'lab-translate') {
        // 临时规则里出现 bailee 时给出不同结果，用来验证"规则起没起作用"看得出来
        const withRule = /bailee/.test(JSON.stringify(msg.payload.profile || {}));
        return {
          ok: true,
          text: withRule ? '由受托保管人占有的货物' : '由受托人占有的货物',
          usage: { input: 80, output: 20 }
        };
      }
      if (msg.type === 'convert-rules') {
        return {
          ok: true,
          yaml: '领域: 法律\n锁定:\n  article: 编\n  bailee: 受托保管人\n风险词:\n  security: 此处指担保权益，不是信息安全'
        };
      }
      if (msg.type === 'query-tab') {
        return {
          ok: true, tabId: 7, url: 'https://example.com/a', injectable: true,
          injected: true, state: null, configured: true, hasPermission: true,
          cache: { entries: 12 }, labSample: 'goods in the possession of a bailee'
        };
      }
      return { ok: true };
    },
    onMessage: { addListener() {} }
  },
  permissions: {
    async contains() {
      return permissionGranted;
    },
    async request() {
      return true;
    },
    async remove() {
      return true;
    },
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  },
  tabs: {
    async sendMessage() {
      return { ok: true };
    }
  }
};

/* ------------------------------ 启动面板 ------------------------------ */

const dom = new JSDOM(html, { url: 'https://example.org/popup.html', runScripts: 'outside-only' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.chrome = chrome;
dom.window.chrome = chrome;
let copiedText = '';
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: { async writeText(value) { copiedText = value; } }
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const $ = (id) => document.getElementById(id);
const fire = (id, type = 'input') => $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const paintDetectedForTest = (state) => dom.window.__byomRepaint(state);

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* -------------------------------- 用例 -------------------------------- */

test('面板能加载并把已存设置画进表单，不抛异常', () => {
  assert.equal($('apiBase').value, 'https://api.deepseek.com');
  assert.equal($('model').value, 'deepseek-v4-flash');
  assert.equal($('targetLang').value, '简体中文');
  assert.ok($('providerId').options.length >= 3, '供应商列表没填充');
  assert.ok($('presetId').options.length >= 5, '语境列表没填充');
});

test('不再存在全局应用栏，事务型配置各自拥有应用按钮', () => {
  assert.equal($('applyRow'), null, '全局应用栏不该继续存在');
  assert.equal($('applyModel').disabled, true);
  assert.equal($('applyRules').disabled, true);
});

test('首次未配置时，直接进入设置视图的模型页', () => {
  assert.equal($('homeView').hidden, true, '首次未配置时不应停在无法使用的首页');
  assert.equal($('settingsView').hidden, false);
  const model = document.querySelector('.settings-panel[data-panel="model"]');
  assert.equal(model.hidden, false, '第一次使用应直接显示模型与 API');
});

test('折叠摘要读表单当前值，未应用的改动也看得见', () => {
  assert.ok($('peekModel').textContent.includes('待配置'), '未完成的模型配置没有反映在摘要里');
  $('apiKey').value = 'sk-test-123';
  fire('apiKey');
  assert.equal($('applyModel').disabled, false, '模型改动没有进入待应用状态');
});

test('填了 Key 但还没应用时，主按钮不该锁死', () => {
  assert.equal($('go').disabled, false, '表单已填完整却仍无法点击翻译');
});

test('应用模型设置会落库并把配置推送到当前标签页', async () => {
  sent.length = 0;
  $('applyModel').click();
  await tick();
  await tick();

  assert.equal(stored.settings.apiKey, 'sk-test-123', '设置没有写入 storage');
  const sync = sent.find((m) => m.type === 'sync-on-tab');
  assert.ok(sync, '没有向当前标签页推送配置——悬浮球这类开关会开了不生效');
  assert.equal(sync.payload.tabId, 7);
  assert.equal($('applyModel').disabled, true, '应用后仍显示未应用');
});

test('切换供应商会带出默认地址与默认模型', async () => {
  // 切换现在是异步的：要先把当前账户存回去，再读出目标账户
  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.equal($('apiBase').value, 'https://api.openai.com/v1');
  assert.equal($('model').value, 'gpt-4o-mini');
  assert.ok($('providerHint').textContent.length > 0, '协议提示没跟着切换');
  assert.equal($('applyModel').disabled, false);
});

test('背景模板点一下就填进输入框并标脏', () => {
  const chip = $('bgChips').querySelector('.chip');
  assert.ok(chip, '模板标签没有渲染');
  chip.click();
  assert.ok($('background').value.length > 10, '模板没有填入');
  assert.ok($('bgCount').textContent.startsWith(String($('background').value.length)));
  assert.equal($('applyRules').disabled, false);
});

test('Sunset Ink 默认显示自定义字色；切回跟随原文会收起取色器', () => {
  assert.equal($('translationColor').value, 'custom');
  assert.equal($('customColors').hidden, false);
  $('translationColor').value = 'inherit';
  fire('translationColor', 'change');
  assert.equal($('customColors').hidden, true, '切回跟随原文后取色器仍占位置');
  $('translationColor').value = 'custom';
  fire('translationColor', 'change');
});

test('外观与普通开关即时保存，不需要应用按钮', async () => {
  $('translationStyle').value = 'tint';
  fire('translationStyle', 'change');
  await tick();
  await tick();
  assert.equal(stored.settings.translationStyle, 'tint');
  assert.equal($('applyModel').disabled, false, '外观即时保存不应擅自清掉模型草稿');
});

test('整页优先默认开启且可手动关闭；precedent Beta 仍默认关闭', async () => {
  assert.equal($('wholePageTranslation').checked, true, '安全范围内整页优先应默认开启');
  $('wholePageTranslation').checked = false;
  fire('wholePageTranslation', 'change');
  await tick();
  await tick();
  assert.equal(stored.settings.wholePageTranslation, false);

  // 不把关闭状态泄漏给后续用例。
  $('wholePageTranslation').checked = true;
  fire('wholePageTranslation', 'change');
  await tick();
  await tick();

  assert.equal($('semanticPrecedent').checked, false, 'precedent 实验不应默认开启');
  $('semanticPrecedent').checked = true;
  fire('semanticPrecedent', 'change');
  await tick();
  await tick();
  assert.equal(stored.settings.semanticPrecedent, true);
  $('semanticPrecedent').checked = false;
  fire('semanticPrecedent', 'change');
  await tick();
  await tick();
});

test('复制 Key 取当前输入框草稿，不要求先应用或显示明文', async () => {
  $('apiKey').value = 'sk-unsaved-copy';
  fire('apiKey');
  $('copyApiKey').click();
  await tick();
  assert.equal(copiedText, 'sk-unsaved-copy');
  assert.equal($('apiKey').type, 'password');
  assert.equal($('copyApiKey').textContent, '已复制');
});

test('悬浮球位置行跟着开关显示', () => {
  assert.ok($('fabPosRow'), '位置选择行不存在');
  assert.equal($('floatButton').checked, true, '悬浮球默认应当开启');
  assert.equal($('fabPosRow').hidden, false, '悬浮球开着时位置选择应当可见');

  $('floatButton').checked = false;
  fire('floatButton', 'change');
  assert.equal($('fabPosRow').hidden, true, '关掉悬浮球后位置选择不该占着位置');

  $('floatButton').checked = true;
  fire('floatButton', 'change');
});

test('切换服务商不丢 Key：各家账户独立保存、切回来还在', async () => {
  // 先给当前这家（OpenAI）填一份
  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  $('apiKey').value = 'sk-openai-aaa';
  $('model').value = 'gpt-4o-mini';
  fire('apiKey');
  $('applyModel').click();
  await tick();
  await tick();

  // 切到 DeepSeek：应当恢复此前保存的 DeepSeek 账户，而不是串用 OpenAI Key
  $('providerId').value = 'deepseek';
  fire('providerId', 'change');
  await tick();
  assert.equal($('apiBase').value, 'https://api.deepseek.com');
  assert.equal($('model').value, 'deepseek-v4-flash');
  assert.equal($('apiKey').value, 'sk-test-123', '应恢复此前保存的 DeepSeek Key，而不是串用 OpenAI Key');

  $('apiKey').value = 'sk-deepseek-bbb';
  fire('apiKey');
  $('applyModel').click();
  await tick();
  await tick();

  // 切回 OpenAI：原来那份必须还在
  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  assert.equal($('apiKey').value, 'sk-openai-aaa', '切回来 Key 丢了');
  assert.equal($('apiBase').value, 'https://api.openai.com/v1');

  // 两份都在 storage 里
  assert.equal(stored.settings.accounts.openai.apiKey, 'sk-openai-aaa');
  assert.equal(stored.settings.accounts.deepseek.apiKey, 'sk-deepseek-bbb');
});

test('已配置的服务商列表可见', () => {
  assert.ok($('accountsHint').textContent.includes('已保存 Key'), '没有提示哪几家已配好');
});


test('悬浮球默认开启——它存在的意义就是不用先打开面板', () => {
  assert.equal($('floatButton').checked, true, '悬浮球默认应当是开的');
});

test('Key 格式提示与「去哪里拿」链接跟着服务商走', async () => {
  $('providerId').value = 'anthropic';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.ok($('keyNote').textContent.includes('sk-ant-'), '没有给出这家的 Key 格式');
  assert.equal($('keyLink').hidden, false, '应当给出获取 Key 的入口');
  assert.ok($('keyLink').href.includes('anthropic.com'));
  assert.ok($('modelNote').textContent.includes('claude'), '没有给出模型名示例');

  // 贴了别家的 Key 应当提示，但不拦截
  $('apiKey').value = 'sk-openai-wrong';
  fire('apiKey');
  assert.equal($('keyNote').dataset.tone, 'warn');
  assert.equal($('go').disabled, false, '格式提示不该拦住用户');
});

test('粘贴整条接口地址会被自动收拾干净', () => {
  $('apiBase').value = 'https://api.anthropic.com/v1/messages';
  fire('apiBase', 'change');
  assert.equal($('apiBase').value, 'https://api.anthropic.com/v1', '末尾的接口路径没被去掉');
  assert.ok($('baseNote').textContent.includes('接口路径'), '改了什么应当说明');
});

test('拉取模型把清单填进候选，不用去翻文档抄模型名', async () => {
  $('fetchModels').click();
  await tick();
  await tick();
  await tick();
  const opts = [...$('modelHints').options].map((o) => o.value);
  assert.deepEqual(opts, ['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
  assert.ok($('modelNote').textContent.includes('3 个模型'));
  assert.equal($('modelNote').dataset.tone, 'ok');
});

test('日常流程只有两层：首页任务区 + 一级设置 Tab', () => {
  $('closeSettings').click();
  assert.equal($('homeView').hidden, false);
  const homeIds = [...$('homeView').children].map((el) => el.id).filter(Boolean);
  assert.deepEqual(homeIds, ['taskCard', 'contextCard', 'consistencyCard'], '首页只应保留高频任务、语境和语义一致性观测');

  $('openSettings').click();
  assert.equal($('settingsView').hidden, false);
  const tabs = [...document.querySelectorAll('#settingsTabs .settings-tab')].map((b) => b.dataset.tab);
  assert.deepEqual(tabs, ['model', 'style', 'rules', 'tools']);
  assert.equal(document.querySelectorAll('details.fold').length, 0, '设置不应再依赖多层折叠菜单');
});

test('主任务把目标语言、显示方式和翻译按钮放在一起', () => {
  const task = $('taskCard');
  assert.ok(task.contains($('targetLang')));
  assert.ok(task.contains($('displayMode')));
  assert.ok(task.contains($('go')));
  assert.ok(!$('settingsView').contains($('displayMode')), '高频显示方式不该再藏在设置视图里');
  assert.equal(document.querySelectorAll('#displaySegments .seg-btn').length, 3, '显示方式应该是可直接点的三段切换');
});

test('页面语境只负责读，人工覆盖集中在页面规则', () => {
  const context = $('contextCard');
  const rules = document.querySelector('.settings-panel[data-panel="rules"]');

  assert.ok(context.contains($('rulesTree')), '自动语境的约束没有留在只读区');
  assert.ok(context.contains($('detected')));
  assert.ok(context.contains($('preflight')), '重新读取应当留在自动语境旁边');
  assert.ok(!context.contains($('background')), '背景输入框不该占着只读区');
  assert.ok(!context.contains($('rulesText')), '规则编辑框不该占着只读区');
  assert.ok(!context.contains($('presetId')), '页面类型的人工覆盖应当在页面规则');

  assert.ok(rules.contains($('background')) && rules.contains($('rulesText')) && rules.contains($('customPrompt')));
  const scopes = [...rules.querySelectorAll('.scope-tag')].map((e) => e.textContent.trim());
  assert.deepEqual(scopes, ['本页', '可选', '全局'], '规则作用域没有显示清楚');
});

test('fallback 是正常状态，不再显示“识别依据不足”警告', () => {
  paintDetectedForTest({ presetId: 'general', presetReason: 'fallback', hasProfile: false, profileYaml: '' });
  assert.equal($('detected').dataset.tone, '', '默认兜底不应该被画成异常');
  assert.ok($('detected').textContent.includes('可以直接翻译'));
  assert.equal($('goCalibrate').hidden, false, '页面规则入口应当一直可用，但只是普通次级动作');
  assert.equal($('goCalibrate').textContent.trim(), '调整页面规则 →');
});

test('页面画像优先显示领域和有价值的建议，不显示置信度诊断', () => {
  paintDetectedForTest({
    presetId: 'general',
    presetReason: 'fallback',
    hasProfile: true,
    profileYaml: '领域: Wayland, Linux 图形栈\n优先:\n  compositor: 合成器'
  });
  assert.equal($('detected').dataset.tone, '');
  assert.ok($('detected').textContent.includes('Wayland'));
  assert.ok(!$('detected').textContent.includes('依据不足'));
  assert.ok($('profileInfo').textContent.includes('1 个术语建议'), '没有如实报出有效建议');
  assert.ok($('rulesTree').innerHTML.includes('compositor'), '画像没有渲染进树');
});

test('预检没有额外规则也是正常结果，不催用户人工校准', () => {
  paintDetectedForTest({ presetId: 'general', presetReason: 'fallback', hasProfile: true, profileYaml: '' });
  assert.equal($('profileInfo').dataset.tone, '');
  assert.ok($('profileInfo').textContent.includes('没有需要额外约束'), '空画像应该解释成“无需额外规则”');
  assert.ok(!$('profileInfo').textContent.includes('重新预检'));
});

test('悬浮球属于显示与外观，低频显示细节不会挤占主任务', () => {
  const style = document.querySelector('.settings-panel[data-panel="style"]');
  assert.ok(style.contains($('floatButton')), '悬浮球开关不该待在语境卡片里');
  assert.ok(!style.contains($('displayMode')), '双语/仅译文是当前任务选项，应当在主卡片');
});

test('自动语境默认开启，但用用户语言解释而不是暴露“预检”机制', () => {
  assert.equal($('autoPreflight').checked, true, '整页语境读取应当默认发生');
  paintDetectedForTest({ presetId: 'general', presetReason: 'host', hasProfile: false, profileYaml: '' });
  assert.ok($('profileInfo').textContent.includes('自动读取整页语境'), '没有说明翻译时会自动读取页面');
});

test('自然语言转规则：结果回填到可编辑框，不直接生效', async () => {
  $('background').value = '这是 UCC 法律条文，article 译作编，bailee 用受托保管人，security 一词有歧义';
  fire('background');

  $('convertRules').click();
  await tick();
  await tick();
  await tick();

  assert.ok($('rulesText').value.includes('article: 编'), '转换结果没有回填');
  assert.ok($('rulesText').value.includes('bailee: 受托保管人'));
  assert.equal($('applyRules').disabled, false, '转完应当是待应用状态，而不是直接生效');
  assert.ok($('rulesNote').textContent.includes('锁定 2 词'), '没有告诉用户解析到了什么');
  assert.ok($('rulesNote').textContent.includes('1 个已注明义项'), '没有反馈风险词的义项覆盖情况');
  assert.equal($('rulesNote').dataset.tone, 'ok');
});

test('手改规则当场校验，格式坏了立刻提示', () => {
  $('rulesText').value = '这一段完全不是规则';
  fire('rulesText');
  assert.equal($('rulesNote').dataset.tone, 'warn', '解析不出规则却没有提示');

  $('rulesText').value = '锁定:\n  article: 编';
  fire('rulesText');
  assert.equal($('rulesNote').dataset.tone, 'ok');
  assert.ok($('rulesNote').textContent.includes('锁定 1 词'));
});

test('本地服务不强制填 Key', async () => {
  $('providerId').value = 'ollama';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.equal($('apiKey').value, '', '本地档不该带 Key');
  assert.ok($('keyNote').textContent.includes('不需要 Key'), '没有说明这家不用填 Key');

  // 模型名仍然必填（得先 ollama pull 一个），但 Key 不该再拦人
  assert.equal($('go').disabled, true, '模型没填时本就该锁住');
  $('model').value = 'qwen2.5:7b';
  fire('model');
  assert.equal($('go').disabled, false, '本地服务填了模型却因为没 Key 仍被锁住');

  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  await tick();
});

test('维护操作已经降到工具与高级里，清理按钮仍各自说清范围', () => {
  const tools = document.querySelector('.settings-panel[data-panel="tools"]');
  assert.ok(tools.contains($('resetAll')) && tools.contains($('clearCache')), '维护动作没有降到工具区');
  assert.ok($('clearCache').textContent.includes('仅清缓存'), '仅清缓存的按钮文案不明确');
});

test('预检结果渲染成树，并可采纳为规则', async () => {
  // 大纲区显示的是"合并后真正生效的那一份"，所以在预检之前
  // 只要用户已经写了规则，它就该出现——这不是画像专属的展示区
  $('preflight').click();
  await tick();
  await tick();
  await tick();

  const tree = $('rulesTree').innerHTML;
  assert.ok(tree.includes('compositor') && tree.includes('合成器'), '大纲没有渲染成树');
  assert.ok(tree.includes('显示输出设备'), '风险词的义项没有展示出来');
  assert.ok(tree.includes('rt-risky'), '风险词没有独立分区');
  // 页面原则是祈使句：说"这页该怎么翻"，不是"这页讲什么"
  assert.equal($('pagePrinciple').hidden, false, '页面原则没有显示');
  assert.ok($('pagePrinciple').textContent.includes('原样保留'));

  // 采纳是显式动作：倒进规则框后优先级从"模型猜的"升到"人定的"
  const before = $('rulesText').value;
  $('adoptProfile').click();
  assert.notEqual($('rulesText').value, before, '采纳后规则框没有变化');
  assert.ok($('rulesText').value.includes('compositor: 合成器'));
  assert.equal($('applyRules').disabled, false, '采纳后应当是待应用状态');
});

test('临时翻译和性能参数都降级到工具与高级，不再占一级入口', () => {
  const tools = document.querySelector('.settings-panel[data-panel="tools"]');
  assert.ok(tools.contains($('labInput')) && tools.contains($('concurrency')) && tools.contains($('debug')));
  assert.equal(document.querySelectorAll('.settings-panel[data-panel="tools"] details').length, 0, '高级页不应再套子菜单');
});

test('试译台自动带上页面里双击过的那段原文', () => {
  assert.equal(
    $('labInput').value,
    'goods in the possession of a bailee',
    '页面上双击留下的样本没有带过来'
  );
});

test('工具里的临时翻译仍带上本页语境', async () => {
  $('labInput').value = 'goods in the possession of a bailee';
  fire('labInput');
  $('labRun').click();
  await tick();
  await tick();
  await tick();
  assert.equal($('labOut').hidden, false, '结果区没有出现');
  assert.ok($('labResult').textContent.includes('受托'), '没有拿到译文');
  assert.ok($('labNote').textContent.includes('token'), '没有显示这次的成本');
});

test('面板显著位置显示版本号，方便横向对比不同版本的译文', () => {
  const el = $('ver');
  assert.ok(el, '缺少版本号元素');
  assert.equal(el.textContent, 'v15.0', '版本号应取自 manifest');
  assert.ok(el.closest('header'), '版本号应在页头，而不是藏在折叠区里');
});

test('站点规则可以勾选打开即翻', () => {
  assert.ok($('siteAuto'), '缺少本站自动翻译开关');
  assert.equal($('siteAuto').checked, false);
});

/* -------------------------------- 运行 -------------------------------- */

await import(resolve(here, '../src/popup/popup.js'));
await tick();
await tick();
await tick();

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
