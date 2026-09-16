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
const manifest = JSON.parse(readFileSync(resolve(here, '../manifest.json'), 'utf8'));
const { copyAcceptanceLog } = await import('../src/popup/diagnostics.js');

/* ------------------------------ chrome 桩 ------------------------------ */

const sent = [];
const tabSent = [];
let stored = {};
let permissionGranted = true;

const chrome = {
  i18n: { getUILanguage: () => 'zh-CN' },
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
    getManifest: () => manifest,
    async sendMessage(msg) {
      sent.push(msg);
      if (msg.type === 'save-settings') {
        const { persistSettingsPatch } = await import('../src/shared/settings.js');
        return { ok: true, settings: await persistSettingsPatch(msg.payload.patch) };
      }
      if (msg.type === 'preflight-on-tab') {
        return {
          ok: true,
          profile: { domain: ['Wayland'], hard: {}, preferred: { compositor: '合成器' }, risky: { output: '显示输出设备' }, keep: [] },
          profileYaml: '原则: 命令与参数原样保留，不做文学化润色\n领域: Wayland\n优先:\n  compositor: 合成器\n风险词:\n  output: 显示输出设备'
        };
      }
      if (msg.type === 'get-lifecycle-log') {
        if (lifecycleOverride) return { ok: true, lifecycle: lifecycleOverride };
        return lifecycleFails ? { ok: false, error: { message: 'unavailable' } } : {
          ok: true,
          lifecycle: {
            format: 'just-translate-lifecycle/v2', epoch: 'epoch-2', droppedBefore: 0, writeFailures: 0, eventCount: 4,
            events: [
              { n: 1, at: '2026-09-08T00:00:00.000Z', event: 'worker-start', details: { epoch: 'epoch-1' } },
              { n: 2, at: '2026-09-08T00:01:00.000Z', event: 'translate-chunk', details: { unitCount: 8, requests: 1, wholePageCacheHit: false, failed: 0 } },
              { n: 3, at: '2026-09-08T00:06:00.000Z', event: 'worker-start', details: { epoch: 'epoch-2' } },
              { n: 4, at: '2026-09-08T00:07:00.000Z', event: 'translate-chunk', details: { unitCount: 8, requests: 0, wholePageCacheHit: true, failed: 0 } }
            ]
          }
        };
      }
      if (msg.type === 'clear-lifecycle-log') return { ok: !lifecycleFails };
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
    async sendMessage(tabId, msg) {
      tabSent.push({ tabId, msg });
      if (msg?.type === 'get-diagnostics') {
        return {
          ok: true,
          diagnostic: {
            format: 'just-translate-diagnostic/v1',
            logId: 'page-session-7', throughSequence: 42,
            generatedAt: '2026-08-30T00:00:00.000Z',
            startedAt: '2026-08-30T00:00:00.000Z',
            privacy: 'No secrets.',
            translationRuntime: { translationMode: 'chunked', translateRequestCount: 3 },
            eventCount: 1,
            events: [{ n: 1, at: '2026-08-30T00:00:00.000Z', elapsedMs: 0, event: 'translate-error', details: { status: 429 } }]
          }
        };
      }
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
let clipboardFails = false;
let lifecycleFails = false;
let lifecycleOverride = null;
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: { async writeText(value) { if (clipboardFails) throw new Error('clipboard denied'); copiedText = value; } }
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

test('免 Key 引擎隐藏 Key/模型与 LLM 功能，Google 固定地址、DeepLX 保留自托管地址', async () => {
  $('providerId').value = 'google-translate';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.equal($('apiBase').value, 'https://translate.googleapis.com');
  assert.equal($('apiBaseField').hidden, true);
  assert.equal($('apiKeyField').hidden, true);
  assert.equal($('modelField').hidden, true);
  assert.equal($('contextCard').hidden, true);
  assert.equal($('consistencyCard').hidden, true);
  assert.equal(document.querySelector('.settings-tab[data-tab="rules"]').hidden, true);
  assert.equal($('machineModeNote').hidden, false);
  assert.equal($('go').disabled, false, '免 Key 引擎仍被 Key/模型字段锁死');

  $('providerId').value = 'deeplx';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.equal($('apiBaseField').hidden, false);
  assert.equal($('apiBase').value, 'http://localhost:1188/translate');
  assert.equal($('apiKeyField').hidden, true);
  assert.equal($('modelField').hidden, true);

  // 恢复带 Key 的引擎，避免把模式状态泄漏给后续规则用例。
  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  await tick();
  assert.equal($('contextCard').hidden, false);
  assert.equal(document.querySelector('.settings-tab[data-tab="rules"]').hidden, false);
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
  assert.equal($('copyApiKey').dataset.feedbackLabel, '已复制');
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
  const opts = [...$('model').options].map((o) => o.value);
  assert.equal($('model').tagName, 'SELECT');
  assert.equal($('modelHints'), null);
  for (const id of ['gpt-4o', 'gpt-4o-mini', 'o3-mini']) assert.ok(opts.includes(id));
  assert.ok($('model').value, '拉取列表不能清除当前选择');
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
  assert.ok(context.contains($('copyProfile')), '完整语境复制应当留在页面语境旁边');
  assert.equal($('copyProfile').closest('details'), null, '复制语境不应依赖展开详情');
  assert.ok(!context.contains($('background')), '背景输入框不该占着只读区');
  assert.ok(!context.contains($('rulesText')), '规则编辑框不该占着只读区');
  assert.ok(!context.contains($('presetId')), '页面类型的人工覆盖应当在页面规则');

  assert.ok(rules.contains($('background')) && rules.contains($('rulesText')) && rules.contains($('customPrompt')));
  const scopes = [...rules.querySelectorAll('.scope-tag')].map((e) => e.textContent.trim());
  assert.deepEqual(scopes, ['本页', '可选', '全局'], '规则作用域没有显示清楚');
});

test('fallback 是正常状态，不再显示“识别依据不足”警告', () => {
  paintDetectedForTest({ presetId: 'general', presetReason: 'fallback', hasProfile: false, profileYaml: '' });
  assert.equal($('copyProfile').disabled, true, '没有画像时不能复制上一页的内容');
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
  $('model').value = '__jt_custom_model__';
  fire('model', 'change');
  $('customModel').value = 'qwen2.5:7b';
  fire('customModel');
  assert.equal($('go').disabled, false, '本地服务填了模型却因为没 Key 仍被锁住');

  $('providerId').value = 'openai';
  fire('providerId', 'change');
  await tick();
  await tick();
});

test('维护操作已经降到工具与高级里，清理按钮仍各自说清范围', () => {
  const tools = document.querySelector('.settings-panel[data-panel="tools"]');
  assert.ok(tools.contains($('resetAll')) && tools.contains($('clearCache')) && tools.contains($('copyDiagnostics')), '维护动作没有降到工具区');
  assert.ok($('clearCache').textContent.includes('仅清缓存'), '仅清缓存的按钮文案不明确');
});

test('一次性诊断从当前页读取、写入剪贴板后才清空，并补齐引擎与权限状态', async () => {
  tabSent.length = 0;
  copiedText = '';
  $('copyDiagnostics').click();
  await tick();
  await tick();
  await tick();

  const copied = JSON.parse(copiedText);
  assert.equal(copied.format, 'just-translate-diagnostic/v1');
  assert.equal(copied.events[0].details.status, 429);
  assert.equal(copied.translationRuntime.translateRequestCount, 3);
  assert.ok(copied.engine.providerId);
  assert.equal(typeof copied.panel.hasPermission, 'boolean');
  assert.ok(!copiedText.includes('sk-unsaved-copy'), '诊断包泄漏了 API Key 草稿');
  assert.deepEqual(tabSent.map((row) => row.msg.type), ['get-diagnostics', 'clear-diagnostics']);
  assert.equal($('copyDiagnostics').dataset.feedbackLabel, '已复制');
  assert.deepEqual(tabSent[1].msg.payload, { logId: 'page-session-7', throughSequence: 42 });
});

test('剪贴板写入失败时保留页面诊断日志，不发送清空消息', async () => {
  tabSent.length = 0;
  clipboardFails = true;
  $('copyDiagnostics').click();
  await tick();
  await tick();
  clipboardFails = false;
  assert.deepEqual(tabSent.map((row) => row.msg.type), ['get-diagnostics']);
});

test('验收日志把后台生命周期和页面日志合成一份，且两侧都不清空', async () => {
  tabSent.length = 0;
  copiedText = '';
  $('copyAcceptance').click();
  await tick();
  await tick();
  await tick();
  const bundle = JSON.parse(copiedText);
  assert.equal(bundle.format, 'just-translate-acceptance/v2');
  assert.equal(bundle.background.eventCount, 4);
  assert.equal(bundle.pageDiagnostic.logId, 'page-session-7');
  assert.equal(bundle.acceptance.workerStarts, 2);
  assert.equal(bundle.acceptance.workerRestartObserved, true, '不同代次证明后台重启过，但不能确定原因');
  assert.ok(bundle.engine.providerId && typeof bundle.panel.hasPermission === 'boolean');
  assert.ok(!copiedText.includes('sk-unsaved-copy'), '验收日志泄漏了 API Key 草稿');
  assert.deepEqual(tabSent.map((row) => row.msg.type), ['get-diagnostics'], '复制验收日志不得清空页面日志');
  assert.deepEqual(tabSent[0].msg.payload, { passive: true }, '验收读取必须是被动的，不能往页面日志里记导出事件');
  assert.equal($('copyAcceptance').dataset.feedbackLabel, '已复制', '工具区在设置视图里，反馈必须落在按钮自身');
  assert.ok($('status').textContent.includes('后台 4 条'));
});

test('摘要把整段日志和当前页面会话分开，缓存命中不被最后一次重翻盖掉', async () => {
  copiedText = '';
  $('copyAcceptance').click();
  await tick();
  await tick();
  await tick();
  const { logWindow, currentPage } = JSON.parse(copiedText).acceptance;
  assert.equal(logWindow.translateChunks, 2);
  assert.equal(logWindow.cacheHitChunks, 1, '整段日志里发生过的缓存命中必须能看到');
  assert.equal(logWindow.providerRequests, 1);
  assert.equal(logWindow.failedUnits, 0);
  assert.equal(currentPage.wholePageCacheHit, null, '当前页面缺失这个字段，不能当作未命中');
  assert.equal(currentPage.translateRequestCount, 3, '页面侧运行时统计应直接可读');
});

test('后台日志取不到时仍复制页面部分，并如实标记缺失', async () => {
  lifecycleFails = true;
  copiedText = '';
  $('copyAcceptance').click();
  await tick();
  await tick();
  await tick();
  const bundle = JSON.parse(copiedText);
  assert.deepEqual(bundle.background, { unavailable: true });
  assert.equal(bundle.acceptance.workerStarts, null);
  assert.equal(bundle.acceptance.workerRestartObserved, null);
  assert.equal(bundle.acceptance.logWindow.translateChunks, null);
  assert.equal(bundle.acceptance.logWindow.providerRequests, null);
  assert.equal(bundle.acceptance.logWindow.incomplete, true);
  assert.equal($('copyAcceptance').dataset.feedbackLabel, '已复制');
  $('clearAcceptance').click();
  await tick();
  assert.equal($('clearAcceptance').dataset.feedbackLabel, '清空失败', '清空失败必须明说，不能谎称已清空');
  assert.ok($('status').textContent.includes('清空失败'));
  lifecycleFails = false;
  $('clearAcceptance').click();
  await tick();
  assert.equal($('clearAcceptance').dataset.feedbackLabel, '已清空');
  assert.ok($('status').textContent.includes('已清空'));
});

test('验收摘要使用清空起点识别一次重启，缺失或截断证据不报告确定的否定', async () => {
  const anchor = { event: 'capture-start', details: { epoch: 'a' } };
  const inspect = async (events, meta = {}) => {
    lifecycleOverride = { epoch: 'a', events, eventCount: events.length, droppedBefore: 0, writeFailures: 0, ...meta };
    await copyAcceptanceLog({ saved: {}, tab: {} });
    return JSON.parse(copiedText).acceptance;
  };
  try {
    assert.equal((await inspect([anchor])).workerRestartObserved, false);
    const restarted = await inspect([anchor, { event: 'worker-start', details: { epoch: 'b' } }], { epoch: 'b' });
    assert.equal(restarted.workerStarts, 1);
    assert.equal(restarted.workerRestartObserved, true);
    assert.equal((await inspect([])).workerRestartObserved, null);
    for (const meta of [{ droppedBefore: 1 }, { writeFailures: 1 }, { unavailable: true }]) {
      const summary = await inspect([anchor], meta);
      assert.equal(summary.workerRestartObserved, null);
      assert.equal(summary.logWindow.providerRequests, null);
      assert.equal(summary.logWindow.incomplete, true);
    }
    assert.equal((await inspect([anchor], { epoch: 'b', droppedBefore: 1 })).workerRestartObserved, true,
      '即使日志不完整，已存在的不同代次仍是正面证据');
  } finally { lifecycleOverride = null; }
});

test('验收请求总数包含失败请求和预检，未知统计不得补零', async () => {
  const events = [
    { event: 'capture-start', details: { epoch: 'a' } },
    { event: 'translate-chunk', details: { requests: 0, failed: 0, wholePageCacheHit: true } },
    { event: 'translate-failed', details: { requests: 1, failureCategory: 'aborted' } },
    { event: 'preflight', details: { requests: 1, cacheSource: 'fresh' } },
    { event: 'preflight', details: { requests: 0, cacheSource: 'background-cache' } },
    { event: 'preflight-failed', details: { requests: 2, failureCategory: 'network' } }
  ];
  lifecycleOverride = { epoch: 'a', events, eventCount: events.length, droppedBefore: 0, writeFailures: 0 };
  try {
    await copyAcceptanceLog({ saved: {}, tab: {} });
    const { logWindow, currentPage } = JSON.parse(copiedText).acceptance;
    assert.equal(logWindow.translationRequests, 1);
    assert.equal(logWindow.preflightRequests, 3);
    assert.equal(logWindow.providerRequests, 4);
    assert.equal(logWindow.cacheHitChunks, 1);
    assert.equal(logWindow.failedUnits, null, '取消时未报告失败单元数，不能补为零');
    assert.deepEqual(logWindow.failureCategories, ['aborted', 'network']);
    assert.equal(currentPage.translateRequestCount, null);
    delete events[2].details.requests;
    await copyAcceptanceLog({ saved: {}, tab: {} });
    assert.equal(JSON.parse(copiedText).acceptance.logWindow.providerRequests, null,
      '旧格式失败事件没有请求数，合计必须标未知');
  } finally { lifecycleOverride = null; }
});

test('连续点击的按钮反馈按最后一次操作计时，旧定时器不能提前恢复文字', async () => {
  const timeout = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 2400) return timeout(fn, ms, ...args);
    const id = {};
    timers.set(id, { at: now + ms, fn, args });
    return id;
  };
  globalThis.clearTimeout = id => { if (!timers.delete(id)) cancel(id); };
  const advance = time => {
    now = time;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(...timer.args); }
  };
  try {
    $('copyAcceptance').click();
    await tick(); await tick();
    advance(1500);
    clipboardFails = true;
    $('copyAcceptance').click();
    await tick(); await tick();
    assert.equal($('copyAcceptance').dataset.feedbackLabel, '复制失败');
    advance(1600);
    assert.equal($('copyAcceptance').dataset.feedbackLabel, '复制失败', '第一次点击的计时器不得盖掉第二次反馈');
    advance(3900);
    assert.equal($('copyAcceptance').dataset.feedback, undefined);
    assert.equal($('copyAcceptance').textContent, '复制验收日志');
    assert.equal(timers.size, 0);
  } finally {
    advance(10000);
    clipboardFails = false;
    globalThis.setTimeout = timeout;
    globalThis.clearTimeout = cancel;
  }
});

test('预检结果可完整复制到剪贴板，并可单独采纳为规则', async () => {
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
  const applied = $('applyRules').disabled;
  const storedBefore = JSON.stringify(stored);
  const messagesBefore = [sent.length, tabSent.length];
  const expected = '原则: 命令与参数原样保留，不做文学化润色\n领域: Wayland\n优先:\n  compositor: 合成器\n风险词:\n  output: 显示输出设备';
  assert.equal($('copyProfile').disabled, false);
  $('copyProfile').click();
  await tick();
  assert.equal(copiedText, expected, '应复制完整自动画像，不混入用户规则或 HTML');
  assert.equal($('rulesText').value, before, '复制不能修改规则草稿');
  assert.equal($('applyRules').disabled, applied, '复制不能改变待应用状态');
  assert.equal(JSON.stringify(stored), storedBefore, '复制不能持久化设置');
  assert.deepEqual([sent.length, tabSent.length], messagesBefore, '复制不能触发预检或修改页面');

  clipboardFails = true;
  try {
    $('copyProfile').click();
    await tick();
    assert.ok($('status').textContent.includes('复制失败'));
    assert.equal($('copyProfile').disabled, false, '复制失败后应允许重试');
  } finally {
    clipboardFails = false;
  }
  $('copyProfile').click();
  await tick();
  assert.equal(copiedText, expected, '复制失败不能丢失原画像');

  $('adoptProfile').click();
  assert.notEqual($('rulesText').value, before, '采纳后规则框没有变化');
  assert.ok($('rulesText').value.includes('compositor: 合成器'));
  assert.equal($('applyRules').disabled, false, '采纳后应当是待应用状态');
});

test('临时翻译和性能参数都降级到工具与高级，不再占一级入口', () => {
  const tools = document.querySelector('.settings-panel[data-panel="tools"]');
  assert.ok(tools.contains($('labInput')) && tools.contains($('concurrency')) && tools.contains($('debug')));
  assert.equal(document.querySelectorAll('.settings-panel[data-panel="tools"] details button, .settings-panel[data-panel="tools"] details input').length, 0, '高级页动作不应藏进子菜单，说明文字可以折叠');
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
  assert.equal(el.textContent, `v${manifest.version}`, '版本号应取自 manifest');
  assert.ok(el.closest('header'), '版本号应在页头，而不是藏在折叠区里');
});

test('站点规则可以勾选打开即翻', () => {
  assert.ok($('siteAuto'), '缺少本站自动翻译开关');
  assert.equal($('siteAuto').checked, false);
});

test('应用期间继续编辑规则，回执后按钮仍可应用新草稿', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  chrome.runtime.sendMessage = async msg => {
    const result = await original(msg);
    if (msg.type === 'save-settings') await gate;
    return result;
  };
  try {
    $('rulesText').value = '领域: Linux';
    fire('rulesText');
    $('applyRules').click();
    await tick();
    $('rulesText').value = '领域: Wayland';
    fire('rulesText');
    release();
    await tick();
    await tick();
    assert.equal(stored.settings.rulesText, '领域: Linux');
    assert.equal($('rulesText').value, '领域: Wayland');
    assert.equal($('applyRules').disabled, false);
    assert.ok($('rulesApplyNote').textContent.includes('未应用'));
  } finally { release(); chrome.runtime.sendMessage = original; }
  $('applyRules').click();
  await tick();
  await tick();
  assert.equal(stored.settings.rulesText, '领域: Wayland');
  assert.equal($('applyRules').disabled, true);
});

test('模型保存期间切换服务商，界面与草稿不被旧回执切回', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  chrome.runtime.sendMessage = async msg => {
    const result = await original(msg);
    if (msg.type === 'save-settings') await gate;
    return result;
  };
  try {
    $('apiKey').value = 'submitted-key';
    fire('apiKey');
    $('applyModel').click();
    await tick();
    $('providerId').value = 'openai';
    fire('providerId', 'change');
    $('apiKey').value = 'new-provider-draft';
    fire('apiKey');
    release();
    await tick();
    await tick();
    assert.equal($('providerId').value, 'openai');
    assert.equal($('apiKey').value, 'new-provider-draft');
    assert.equal($('applyModel').disabled, false);
  } finally { release(); chrome.runtime.sendMessage = original; }
});

test('保存失败不启动翻译，草稿保留且用户能看到失败', async () => {
  const original = chrome.runtime.sendMessage;
  sent.length = 0;
  chrome.runtime.sendMessage = msg => msg.type === 'save-settings'
    ? Promise.resolve({ ok: false, error: { message: 'storage unavailable' } })
    : original(msg);
  try {
    $('go').click();
    await tick();
    await tick();
    assert.equal(sent.some(msg => msg.type === 'start-on-tab'), false);
    assert.equal($('apiKey').value, 'new-provider-draft');
    assert.equal($('applyModel').disabled, false);
    assert.ok(document.body.textContent.includes('操作未完成'));
  } finally { chrome.runtime.sendMessage = original; }
});

test('诊断无页面日志时仍能复制，权限取实际检查结果而非旧标签状态', async () => {
  const original = chrome.tabs.sendMessage;
  tabSent.length = 0;
  permissionGranted = false;
  chrome.tabs.sendMessage = async (tabId, msg) => {
    tabSent.push({ tabId, msg });
    return { ok: false };
  };
  try {
    $('copyDiagnostics').click();
    await tick();
    await tick();
    const report = JSON.parse(copiedText);
    assert.equal(report.panel.hasPermission, false);
    assert.equal(report.events[0].event, 'content-log-unavailable');
    assert.deepEqual(tabSent.map(row => row.msg.type), ['get-diagnostics']);
  } finally { chrome.tabs.sendMessage = original; permissionGranted = true; }
});

test('日志复制成功但清空失败仍报告已复制，不谎称已清空', async () => {
  const original = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = (tabId, msg) => msg.type === 'clear-diagnostics'
    ? Promise.reject(new Error('tab closed')) : original(tabId, msg);
  try {
    $('copyDiagnostics').click();
    await tick();
    await tick();
    assert.equal($('copyDiagnostics').dataset.feedbackLabel, '已复制');
    assert.ok(document.body.textContent.includes('页面日志未能清空'));
  } finally { chrome.tabs.sendMessage = original; }
});

test('权限检查乱序不把旧服务商权限用于新地址，申请仍在点击内发起', async () => {
  const oldContains = chrome.permissions.contains;
  const oldRequest = chrome.permissions.request;
  const pending = [];
  const requested = [];
  chrome.permissions.contains = options => new Promise(resolve => pending.push({ options, resolve }));
  chrome.permissions.request = options => { requested.push(options); return Promise.resolve(false); };
  try {
    $('providerId').value = 'openai';
    fire('providerId', 'change');
    $('providerId').value = 'deepseek';
    fire('providerId', 'change');
    assert.equal(pending.length, 2);
    pending[1].resolve(false);
    await tick();
    pending[0].resolve(true);
    await tick();
    $('go').click();
    assert.equal(requested.length, 1, '权限申请必须在 click 返回前发起');
    assert.deepEqual(requested[0].origins, ['https://api.deepseek.com/*']);
    await tick();
  } finally {
    for (const item of pending) item.resolve(false);
    chrome.permissions.contains = oldContains;
    chrome.permissions.request = oldRequest;
  }
});

/* -------------------------------- 运行 -------------------------------- */

test('切换用户语言更新所有界面分区，不保存模型草稿、不显示 Key', async () => {
  const key = $('apiKey');
  key.value = 'sk-unapplied-language-test';
  fire('apiKey');
  const savedKey = stored.settings.apiKey;
  const rulesDraft = $('rulesText').value;
  const model = $('model').value;
  const selector = $('model');
  $('targetLang').value = 'English';
  fire('targetLang', 'change');
  await tick();
  await tick();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal($('goText').textContent, 'Translate page');
  assert.equal($('openSettings').title, 'Settings');
  assert.match($('peekModel').textContent, /DeepSeek/);
  assert.doesNotMatch($('providerHint').textContent, /\p{Script=Han}/u);
  assert.equal($('model'), selector);
  assert.equal($('model').value, model);
  assert.equal(key.value, 'sk-unapplied-language-test');
  assert.equal(key.type, 'password');
  assert.equal(stored.settings.apiKey, savedKey);
  assert.equal($('rulesText').value, rulesDraft);
  assert.equal(stored.settings.targetLang, 'English');
  assert.ok(!Object.hasOwn(stored.settings, 'userLanguage'), '不能另存一份重复语言状态');
  $('targetLang').value = '简体中文';
  fire('targetLang', 'change');
  await tick();
  assert.equal($('openSettings').title, '设置');
  assert.equal(key.value, 'sk-unapplied-language-test');
});

test('其他用户语言使用明确的英文界面兜底，仍按所选语言保存', async () => {
  $('targetLang').value = '日本語';
  fire('targetLang', 'change');
  await tick();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(stored.settings.targetLang, '日本語');
  assert.match($('userLanguageNote').textContent, /interface currently uses English/);
  $('targetLang').value = '简体中文';
  fire('targetLang', 'change');
  await tick();
});

test('正在显示的 Key 切换语言后仍显示 Hide，复制反馈恢复到当前界面语言', async () => {
  $('reveal').click();
  assert.equal($('apiKey').type, 'text');
  $('targetLang').value = 'English';
  fire('targetLang', 'change');
  await tick();
  assert.equal($('reveal').textContent, 'Hide');
  $('reveal').click();
  assert.equal($('apiKey').type, 'password');
  $('targetLang').value = '简体中文';
  fire('targetLang', 'change');
  await tick();
});

test('模型列表迟到时不能污染已切换服务商的选择', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  chrome.runtime.sendMessage = msg => msg.type === 'list-models'
    ? new Promise(resolve => { release = resolve; }) : original(msg);
  try {
    $('providerId').value = 'openai';
    fire('providerId', 'change');
    await tick();
    $('fetchModels').click();
    await tick();
    assert.equal($('fetchModels').disabled, true);
    $('providerId').value = 'deepseek';
    fire('providerId', 'change');
    await tick();
    const model = $('model').value;
    release({ ok: true, ids: ['stale-other-provider'] });
    await tick();
    assert.equal($('model').value, model);
    assert.ok(![...$('model').options].some(o => o.value === 'stale-other-provider'));
    assert.equal($('fetchModels').disabled, false);
  } finally { chrome.runtime.sendMessage = original; }
});

test('空列表与损坏模型清单不破坏现有选择或自定义入口', async () => {
  const original = chrome.runtime.sendMessage;
  try {
    const selected = $('model').value;
    for (const ids of [[], null, { bad: 'shape' }]) {
      chrome.runtime.sendMessage = msg => msg.type === 'list-models'
        ? Promise.resolve({ ok: true, ids }) : original(msg);
      $('fetchModels').click();
      await tick();
      await tick();
      assert.equal($('model').value, selected);
      assert.ok([...$('model').options].some(o => o.value === '__jt_custom_model__'));
      assert.equal($('fetchModels').disabled, false);
    }
  } finally { chrome.runtime.sendMessage = original; }
});


test('测试连接在设置页立即反馈，处理中即使派发重复事件也只调用一次', async () => {
  const original = chrome.runtime.sendMessage;
  let release, count = 0;
  chrome.runtime.sendMessage = msg => msg.type === 'test-connection'
    ? (count++, new Promise(resolve => { release = resolve; })) : original(msg);
  try {
    $('openSettings').click();
    $('test').click();
    assert.equal($('test').getAttribute('aria-busy'), 'true');
    assert.equal($('test').dataset.feedbackLabel, '测试中…');
    assert.equal($('homeView').hidden, true);
    assert.equal($('actionNotice').closest('[hidden]'), null);
    fire('test', 'click');
    await tick();
    assert.equal(count, 1);
    release({ ok: true, echoed: 'ok' });
    await tick();
    assert.equal($('test').dataset.feedback, 'success');
    assert.equal($('test').disabled, false);
    assert.ok($('actionNotice').textContent.includes('连接正常'));
  } finally { chrome.runtime.sendMessage = original; }
});

test('旧操作迟到时只更新自己的按钮，不覆盖较新操作的可见结果', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  chrome.runtime.sendMessage = msg => msg.type === 'test-connection'
    ? new Promise(resolve => { release = resolve; }) : original(msg);
  try {
    $('test').click(); await tick();
    $('fetchModels').click(); await tick(); await tick();
    const latest = $('actionNotice').textContent;
    assert.ok(latest.includes('3 个模型'));
    release({ ok: false, error: { message: 'delayed failure' } }); await tick();
    assert.equal($('actionNotice').textContent, latest);
    assert.equal($('test').dataset.feedback, 'error');
  } finally { chrome.runtime.sendMessage = original; }
});

test('测试超时会解锁并显示原因，迟到成功不能改写超时结果', async () => {
  const original = chrome.runtime.sendMessage;
  const timeout = globalThis.setTimeout;
  let release, expire;
  globalThis.setTimeout = (fn, ms, ...args) => ms === 35000 ? (expire = fn, {}) : timeout(fn, ms, ...args);
  chrome.runtime.sendMessage = msg => msg.type === 'test-connection'
    ? new Promise(resolve => { release = resolve; }) : original(msg);
  try {
    $('test').click(); await tick();
    expire(); await tick();
    assert.equal($('test').disabled, false);
    assert.equal($('test').dataset.feedback, 'error');
    assert.match($('actionNotice').textContent, /超时/);
    const message = $('actionNotice').textContent;
    release({ ok: true, echoed: 'late' }); await tick();
    assert.equal($('actionNotice').textContent, message);
  } finally { globalThis.setTimeout = timeout; chrome.runtime.sendMessage = original; }
});

test('清缓存失败不清零计数，反馈不销毁独立计数节点', async () => {
  const original = chrome.runtime.sendMessage;
  const counter = $('cacheCount');
  counter.textContent = '(143)';
  chrome.runtime.sendMessage = msg => msg.type === 'clear-cache'
    ? Promise.resolve({ ok: false, error: { message: 'storage unavailable' } }) : original(msg);
  try {
    $('clearCache').click(); await tick();
    assert.equal($('cacheCount'), counter);
    assert.equal(counter.textContent, '(143)');
    assert.equal($('clearCache').dataset.feedback, 'error');
    assert.match($('actionNotice').textContent, /storage unavailable/);
    assert.equal($('clearCache').disabled, false);
  } finally { chrome.runtime.sendMessage = original; }
});

test('权限拒绝也要在当前视图反馈，不能显示测试成功', async () => {
  const original = chrome.permissions.request;
  permissionGranted = false;
  $('apiBase').value = 'https://feedback-test.example';
  fire('apiBase');
  chrome.permissions.request = async () => false;
  try {
    $('test').click(); await tick(); await tick();
    assert.equal($('test').dataset.feedback, 'error');
    assert.equal($('test').disabled, false);
    assert.match($('actionNotice').textContent, /权限/);
  } finally { chrome.permissions.request = original; permissionGranted = true; }
});

test('测试期间改模型，旧成功回执不能宣称新配置已通过', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  chrome.runtime.sendMessage = msg => msg.type === 'test-connection'
    ? new Promise(resolve => { release = resolve; }) : original(msg);
  try {
    $('test').click(); await tick();
    $('apiBase').value = 'https://changed.example'; fire('apiBase');
    release({ ok: true, echoed: 'ok' }); await tick();
    assert.equal($('test').dataset.feedback, 'error');
    assert.match($('actionNotice').textContent, /配置已改变/);
  } finally { chrome.runtime.sendMessage = original; }
});

test('规则转换迟到时保留用户后续编辑，并明确提示重新转换', async () => {
  const original = chrome.runtime.sendMessage;
  let release;
  chrome.runtime.sendMessage = msg => msg.type === 'convert-rules'
    ? new Promise(resolve => { release = resolve; }) : original(msg);
  try {
    $('background').value = '原始要求'; fire('background');
    $('convertRules').click(); await tick();
    $('rulesText').value = '领域: 后续编辑'; fire('rulesText');
    release({ ok: true, yaml: '领域: 迟到结果' }); await tick();
    assert.equal($('rulesText').value, '领域: 后续编辑');
    assert.match($('actionNotice').textContent, /已保留当前草稿/);
    assert.equal($('convertRules').disabled, false);
  } finally { chrome.runtime.sendMessage = original; }
});

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
