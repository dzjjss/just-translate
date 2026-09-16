import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Linter } from 'eslint';
import { LANGUAGES, browserUserLanguage, languageOption, normalizeLanguage, interfaceLanguage } from '../src/shared/languages.js';
import { translateUi, localizeMarkup } from '../src/shared/ui-language.js';
import { EN_MESSAGES } from '../src/shared/ui-messages.js';
import { createModelPicker } from '../src/popup/model-picker.js';
import { getSettings, persistSettingsPatch } from '../src/shared/settings.js';
import { renderRulesTree } from '../src/shared/rules-tree.js';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('src/popup/popup.html', root), 'utf8');

test('语言清单使用原生名称，兼容地区、文字子标签和旧语言值', () => {
  assert.equal(new Set(LANGUAGES.map(item => item.value)).size, LANGUAGES.length);
  for (const locale of ['en-US', 'en_Latn_US', 'English']) assert.equal(languageOption(locale)?.value, 'English');
  for (const locale of ['zh-TW', 'zh-Hant-TW', 'zh_HK']) assert.equal(languageOption(locale)?.value, '繁體中文');
  assert.equal(languageOption('ja-JP')?.value, '日本語');
  assert.equal(languageOption('fr-CA')?.value, 'Français');
  assert.equal(languageOption('und'), undefined);
  assert.equal(languageOption('xx-ZZ'), undefined);
  assert.equal(languageOption('zha'), undefined, '不能把名称以 zh 开头的其他语言当成中文');
  assert.equal(normalizeLanguage('zh-Hant-TW'), 'zh');
  assert.equal(interfaceLanguage('English'), 'en');
  assert.equal(interfaceLanguage('日本語'), 'en');
});

test('首次用户语言取浏览器偏好；未知时留空；已有偏好和账户原样保留', async () => {
  let locale = 'en-US';
  let stored = {};
  globalThis.chrome = {
    i18n: { getUILanguage: () => locale, detectLanguage: () => { throw Error('Must not detect page language'); } },
    storage: { local: {
      get: async () => structuredClone(stored),
      set: async value => { stored = structuredClone(value); }
    } }
  };
  assert.equal(browserUserLanguage(), 'English');
  assert.equal((await getSettings()).targetLang, 'English');
  await persistSettingsPatch(null);
  locale = 'ja-JP';
  assert.equal((await getSettings()).targetLang, 'English', '首次偏好保存后不随浏览器环境漂移');
  const original = { targetLang: 'French (Canada)', model: 'private-model', apiKey: 'test-fixture', schemaVersion: 13 };
  stored = { settings: original };
  const loaded = await getSettings();
  for (const [key, value] of Object.entries(original)) assert.equal(loaded[key], value);
  stored = {};
  locale = 'xx-ZZ';
  assert.equal((await getSettings()).targetLang, '', '未知环境不能默默改为中文');
  stored = { settings: { targetLang: '' } };
  locale = 'en-US';
  assert.equal((await getSettings()).targetLang, '', '显式清空后必须等待用户选择');
  delete globalThis.chrome;
});

test('界面消息参数按原样插入，原型名称不触发查表或执行', () => {
  assert.equal(translateUi('English', '设置'), 'Settings');
  assert.equal(translateUi('简体中文', '设置'), '设置');
  assert.equal(translateUi('Français', '设置'), 'Settings');
  const t = (...args) => translateUi('English', ...args);
  assert.equal(t`例：${'中文原文 {1} <script>'}`, 'Example: 中文原文 {1} <script>');
  for (const key of ['__proto__', 'constructor', 'toString']) assert.equal(t(key), key);
});

test('中英界面来回切换不销毁控件、监听器或用户文本', () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const rules = doc.getElementById('rulesText');
  const key = doc.getElementById('apiKey');
  rules.value = '领域: 用户自己的内容，不自动翻译';
  key.value = 'sk-draft-fixture';
  const go = doc.getElementById('go');
  go.disabled = false;
  let clicks = 0;
  go.addEventListener('click', () => clicks++);
  for (const locale of ['English', '简体中文', 'English']) {
    localizeMarkup(doc, locale);
    go.click();
    assert.equal(doc.getElementById('go'), go);
    assert.equal(doc.getElementById('rulesText'), rules);
    assert.equal(rules.value, '领域: 用户自己的内容，不自动翻译');
    assert.equal(key.value, 'sk-draft-fixture');
    assert.equal(key.type, 'password');
  }
  assert.equal(clicks, 3);
  assert.equal(doc.getElementById('reveal').textContent, 'Show');
  assert.doesNotMatch(rules.placeholder, /\p{Script=Han}/u);
  assert.doesNotMatch(doc.body.textContent, /\p{Script=Han}/u, '静态界面遗漏英文文案');
  dom.window.close();
});

test('所有显式界面消息有英文翻译，占位参数不遗漏', () => {
  const doc = new JSDOM(html).window.document;
  const needed = new Set();
  const add = key => { if (typeof key === 'string' && /\p{Script=Han}/u.test(key)) needed.add(key); };
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label']) add(el.getAttribute(attr));
    for (const key of Object.values(JSON.parse(el.dataset.i18nParts || '{}'))) add(key);
  }
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
  const linter = new Linter();
  for (const file of walk(fileURLToPath(new URL('src/', root))).filter(file => file.endsWith('.js'))) {
    const messages = linter.verify(fs.readFileSync(file, 'utf8'), {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { keys: { rules: { collect: { create: () => ({
        CallExpression(node) { if (node.callee.name === 't') add(node.arguments[0]?.value); },
        TaggedTemplateExpression(node) {
          if (node.tag.name === 't') add(node.quasi.quasis.map((q, i) => (i ? `{${i-1}}` : '') + q.value.cooked).join(''));
        }
      }) } } } }, rules: { 'keys/collect': 'error' }
    });
    assert.ok(!messages.some(message => message.fatal), file);
  }
  for (const key of needed) assert.ok(Object.hasOwn(EN_MESSAGES, key), `缺失英文文案: ${key}`);
  for (const [key, message] of Object.entries(EN_MESSAGES)) {
    const params = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(params(message), params(key), `参数遗漏: ${key}`);
  }
});

function pickerFixture() {
  const dom = new JSDOM('<select id="model"></select><input id="custom" hidden>');
  const select = dom.window.document.querySelector('select');
  const custom = dom.window.document.querySelector('input');
  const picker = createModelPicker(select, custom, () => ['one', 'two']);
  return { dom, select, custom, picker };
}

test('模型真下拉不按已有内容过滤，拉取后保留当前模型', () => {
  const { dom, select, custom, picker } = pickerFixture();
  picker.value = 'saved-not-in-list';
  assert.deepEqual([...select.options].map(o => o.value), ['', 'one', 'two', 'saved-not-in-list', '__jt_custom_model__']);
  picker.replaceOptions(['alpha', 'beta']);
  assert.equal(picker.value, 'saved-not-in-list');
  assert.ok([...select.options].some(o => o.value === 'alpha'));
  assert.equal(custom.hidden, true);
  select.value = 'beta';
  picker.changed();
  assert.equal(picker.value, 'beta');
  dom.window.close();
});

test('自定义模型单独输入，刷新列表不丢草稿；空列表仍可手动填', () => {
  const { dom, select, custom, picker } = pickerFixture();
  picker.value = '';
  select.value = '__jt_custom_model__';
  picker.changed();
  assert.equal(custom.hidden, false);
  custom.value = ' private:latest ';
  picker.replaceOptions([]);
  assert.equal(select.value, '__jt_custom_model__');
  assert.equal(custom.value, ' private:latest ');
  assert.equal(picker.value, 'private:latest');
  picker.value = '__jt_custom_model__';
  assert.equal(picker.value, '__jt_custom_model__', '占位值碰撞不能丢掉用户模型 ID');
  dom.window.close();
});

test('模型名称只作为文本，不执行远端 HTML，也不产生重复/空项', () => {
  const { dom, select, picker } = pickerFixture();
  picker.value = 'one';
  const hostile = '<img src=x onerror="alert(1)">';
  picker.replaceOptions([hostile, hostile, '', ' ', null, 15]);
  assert.equal(select.querySelector('img'), null);
  assert.equal([...select.options].filter(o => o.textContent === hostile).length, 1);
  assert.equal(picker.value, 'one');
  dom.window.close();
});

test('语境界面只翻译标题提示，用户术语值仍原样且 HTML 转义', () => {
  const rendered = renderRulesTree({ domain: ['Linux'], preferred: { compositor: '<中文术语>' } }, {}, 'English');
  assert.match(rendered, /Preferred/);
  assert.match(rendered, /&lt;中文术语&gt;/);
  assert.doesNotMatch(rendered, /领域义永远压过/);
});

test('不再携带页面语言检测、同语言闸门、源语言表单或检测状态', () => {
  assert.equal(fs.existsSync(new URL('src/content/page-language.js', root)), false);
  for (const file of ['src/content/main.js', 'src/content/session.js', 'src/popup/popup.js', 'src/content/extractor.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, root), 'utf8'), /assessPageLanguage|detectLanguage|sourceLanguage|setLanguage|alreadyTarget|target-script/);
  }
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.getElementById('targetLang').tagName, 'SELECT');
  assert.equal(doc.getElementById('model').tagName, 'SELECT');
  assert.equal(doc.querySelector('datalist'), null);
});

for (const [name, fn] of cases) { await fn(); console.log('  ✓', name); }
console.log(`${cases.length} 个用例全部通过（语言偏好、原生下拉与界面合同）`);
