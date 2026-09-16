import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { scan, resetIds } from '../src/content/extractor.js';
import { attach, fill } from '../src/content/renderer.js';
import { buildBilingualMarkdown } from '../src/content/digest.js';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://article.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle, location: dom.window.location });
  resetIds();
  return dom;
}

function complete(root = document.body) {
  const units = scan(root, { minTextLength: 1, smartFilter: false, skipTightLayout: false, contentRootOnly: false });
  for (const unit of units) { attach(unit); fill(unit, `译：${unit.text}`); unit.state = 'done'; }
  return units;
}

test('Markdown 导出保持标题、图注、列表的独立边界，文本中的 Markdown 不执行', () => {
  const dom = page('<article><h4>Protocol details</h4><p>Literal *stars*, [link](javascript:bad), &lt;img&gt; and &amp;lt;.</p>'
    + '<figure><img src="x"><figcaption>Figure 1: Frame timing</figcaption></figure>'
    + '<ol start="4"><li>First item</li><li value="9">Second item</li></ol><p>1. Literal numbering</p></article>');
  const output = buildBilingualMarkdown(complete());
  assert.match(output, /^#### Protocol details\n\n\*\*译：Protocol details\*\*\n\n/);
  assert.match(output, /Literal \\\*stars\\\*, \\\[link\\\]/);
  assert.match(output, /\\<img\\> and &amp;lt;/);
  assert.match(output, /\n\n\*Figure 1: Frame timing\*\n\n\*译：Figure 1: Frame timing\*\n\n4\. First item/);
  assert.match(output, /\n\n9\. Second item/);
  assert.ok(output.includes('1\\. Literal numbering'));
  dom.window.close();
});

test('Markdown 表格保留单元格、标题与未翻译的数字列，转义竖线和换行', () => {
  const dom = page('<table><caption>Measurements</caption><thead><tr><th>Name</th><th>Value</th></tr></thead>'
    + '<tbody><tr><td>Alpha | beta</td><td>42<span style="display:none">Internal debug</span></td></tr><tr><td>Pending row</td><td>99</td></tr></tbody></table>');
  const units = complete();
  for (const unit of units) {
    if (unit.text === 'Alpha | beta') fill(unit, '甲 | 乙\n第二行');
    if (['Pending row', '99', '42'].includes(unit.text)) unit.state = 'pending';
  }
  const output = buildBilingualMarkdown(units);
  assert.match(output, /^\*Measurements\*\n\n\*译：Measurements\*\n\n\| Name<br><br>译：Name \| Value<br><br>译：Value \|\n\| --- \| --- \|/);
  assert.match(output, /\| Alpha \\\| beta<br><br>甲 \\\| 乙<br>第二行 \| 42 \|/);
  assert.doesNotMatch(output, /Pending row|99|译：42|Internal debug/);
  dom.window.close();
});

test('无表头与合并单元格不把第一行误作表头，不错配后续列', () => {
  const dom = page('<table><tr><td rowspan="2">Group A</td><td>First value</td></tr>'
    + '<tr><td>Second value</td></tr><tr><td colspan="2">Total value</td></tr></table>');
  const output = buildBilingualMarkdown(complete());
  assert.match(output, /^\|  \|  \|\n\| --- \| --- \|\n\| Group A/);
  assert.match(output, /\n\|  \| Second value<br><br>译：Second value \|/);
  assert.match(output, /\n\| Total value<br><br>译：Total value \|  \|/);
  dom.window.close();
});

test('动态插入与移动之后按当前页面顺序导出，去掉失联、失败与重复单元', () => {
  const dom = page('<article><p id="a">Older paragraph.</p><p id="b">Last paragraph.</p></article>');
  const units = complete();
  const el = document.createElement('h2');
  el.textContent = 'Inserted title';
  document.querySelector('article').prepend(el);
  units.push(...complete(el), units[0]);
  const output = buildBilingualMarkdown(units);
  assert.ok(output.indexOf('Inserted title') < output.indexOf('Older paragraph.'));
  assert.equal(output.match(/译：Older paragraph\./g).length, 1);
  units[0].node.remove();
  units[1].node.dataset.byomHash = 'a newer source now owns this node';
  const filtered = buildBilingualMarkdown(units);
  assert.doesNotMatch(filtered, /Older paragraph|Last paragraph/);
  dom.window.close();
});

test('导航、页脚与控件不泄漏，正文页头、侧栏说明与参考链接仍保留', () => {
  const dom = page('<header><p>Site branding</p></header><nav><p>Navigation label</p></nav>'
    + '<article><header><h2>Article heading</h2></header><aside><p>A meaningful aside.</p></aside>'
    + '<ul><li><a href="/a">Reference A</a></li><li><a href="/b">Reference B</a></li></ul>'
    + '<p>Body paragraph. <button>Copy</button></p></article><footer><p>Site legal links</p></footer>');
  const output = buildBilingualMarkdown(complete());
  assert.doesNotMatch(output, /Site branding|Navigation label|Site legal links|Copy/);
  for (const content of ['Article heading', 'A meaningful aside.', 'Reference A', 'Reference B', 'Body paragraph.']) {
    assert.ok(output.includes(content), content);
  }
  dom.window.close();
});

test('开放组件和插槽的导出沿渲染树排序，仅译文模式不影响原文导出', () => {
  const dom = page('<article><p>Before component.</p><x-story><p slot="story">Slotted paragraph.</p></x-story><p>After component.</p></article>');
  const host = document.querySelector('x-story');
  host.attachShadow({ mode: 'open' }).innerHTML = '<h2>Component heading</h2><slot name="story"></slot><p>Component ending.</p>';
  const units = complete();
  document.documentElement.dataset.byomDisplay = 'translation';
  const output = buildBilingualMarkdown(units.reverse());
  const expected = ['Before component.', 'Component heading', 'Slotted paragraph.', 'Component ending.', 'After component.'];
  const indices = expected.map(value => output.indexOf(value));
  assert.ok(indices.every(index => index >= 0), output);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.equal(document.documentElement.dataset.byomDisplay, 'translation');
  dom.window.close();
});

test('空页、加载中与仅站点界面不制造空白下载文件', () => {
  const dom = page('<nav><p>Navigation only.</p></nav>');
  assert.equal(buildBilingualMarkdown(complete()), '');
  assert.equal(buildBilingualMarkdown([]), '');
  dom.window.close();
});

test('同一列表项中的多个段落不重复编号，嵌套子项归属保持', () => {
  const dom = page('<ul><li>Parent item<p>Second paragraph.</p><ul><li>Child item.</li></ul>Last paragraph.</li></ul>');
  const output = buildBilingualMarkdown(complete());
  assert.equal(output.match(/^- /gm).length, 1);
  assert.match(output, /\n\n  Second paragraph\.\n\n  译：Second paragraph\./);
  assert.match(output, /\n\n  - Child item\.\n\n    译：Child item\./);
  assert.match(output, /\n\n  Last paragraph\.\n\n  译：Last paragraph\./);
  dom.window.close();
});
