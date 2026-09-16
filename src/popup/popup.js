import { MSG, PHASE, PRESET_REASON } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { presetOptions } from '../prompt/presets.js';
import { listProviders } from '../shared/provider-catalog.js';
import { hasApiPermission, originPatternFromUrl } from '../shared/permissions.js';
import { checkKey, normalizeBase } from '../shared/provider-help.js';
import { fromYaml, isEmptyRules, mergeRules } from '../shared/rules-yaml.js';
import { buildSources, renderRulesTree } from '../shared/rules-tree.js';
import { consistencyView, contextPeek, preflightInfo } from './view-model.js';
import { createSettingsForm } from './settings-form.js';
import { clearAcceptanceLog, copyAcceptanceLog, copyPanelDiagnostics } from './diagnostics.js';
import { LANGUAGES, browserUserLanguage, interfaceLanguage, languageLabel, normalizeLanguage } from '../shared/languages.js';
import { localizeMarkup, translateUi } from '../shared/ui-language.js';
import { createModelPicker } from './model-picker.js';
import { actionPending, createActionFeedback, resetActionFeedback, waitForReply } from '../shared/action-feedback.js';
import { ACTION_FEEDBACK_CSS } from '../shared/action-feedback-css.js';
import { runtimeReply, tabReply } from '../shared/ui-request.js';
import { createPopupNotice } from './notice.js';

const $ = (id) => document.getElementById(id);
const uiLanguage = () => $('targetLang')?.value || form?.saved.targetLang || browserUserLanguage();
const t = (...args) => translateUi(uiLanguage(), ...args);
const modelPicker = createModelPicker($('model'), $('customModel'), () => activeProvider()?.models || [], {
  empty: () => t('请选择模型'), custom: () => t('自定义模型…')
});
const formField = id => id === 'model' ? modelPicker : $(id);

/**
 * 设置生命周期：
 * - LIVE：开关、选择器、外观与轻量性能参数，改动后立即保存。
 * - TRANSACTIONAL：模型凭证与长文本规则，用户完成编辑后再一次性应用。
 *
 * 这里故意不再存在“整个设置页统一应用”的概念。新增设置时必须先决定生命周期，
 * 否则很容易重新退化成改一个开关也要多点一次按钮。
 */
const MODEL_FIELDS = ['providerId', 'apiBase', 'apiKey', 'model'];
const RULE_FIELDS = ['background', 'rulesText', 'customPrompt'];
const LIVE_TEXT_FIELDS = ['targetLang', 'translationFont', 'skipSelectors'];
const LIVE_NUM_FIELDS = ['concurrency', 'maxCharsPerChunk'];
const LIVE_BOOL_FIELDS = [
  'useCache', 'smartFilter', 'floatButton', 'autoPreflight',
  'contentRootOnly', 'semanticConsistency', 'semanticPrecedent', 'wholePageTranslation', 'debug'
];
const LIVE_SELECT_FIELDS = [
  'presetId', 'translationStyle', 'translationColor', 'floatPosition', 'displayMode'
];
const COLOR_FIELDS = ['textColorLight', 'textColorDark', 'accentColorLight', 'accentColorDark'];
const ALL_FIELDS = [...new Set([
  ...MODEL_FIELDS, ...RULE_FIELDS, ...LIVE_TEXT_FIELDS, ...LIVE_NUM_FIELDS,
  ...LIVE_SELECT_FIELDS, ...COLOR_FIELDS
])];

let form = null;
let tabInfo = null;
const liveTimers = new Map();
const feedback = createActionFeedback({ translate: text => t(text), announce: createPopupNotice($('actionToast')) });
// 权限状态提前查好：chrome.permissions.request() 必须在用户手势里同步发起，
// 点击处理函数里再 await 一次会把手势上下文吃掉，第一次点必然失败。
let permissionGranted = false;

/**
 * 背景模板。用户最大的障碍不是不会用输入框，是不知道该写什么。
 * 点一下填模板再改，比对着空白框想措辞容易得多。
 */
const BG_TEMPLATES = [
  {
    label: '法律条文',
    text: '这是法律条文页面。术语按大陆法律惯例，article 译作编、section 译作条、subsection 译作款，条文编号与括号标号保留原文形式。'
  },
  {
    label: '技术文档',
    text: '这是软件技术文档。API 名、命令、参数、配置项、错误码一律保留英文原文，同一术语全文保持一致译法。'
  },
  {
    label: '学术论文',
    text: '这是学术论文。保留论证结构与限定语气，不要把推测写成结论；专业术语首次出现时可在括号内保留原文。'
  },
  {
    label: '新闻报道',
    text: '这是新闻报道。人名、机构名、地名、数字与日期不得改动，保留消息来源与转述措辞。'
  },
  {
    label: '产品页面',
    text: '这是产品或营销页面。语气自然口语化，产品名与品牌名保留原文，不要逐字直译标语。'
  }
];

/* ---------------------------------- 初始化 ---------------------------------- */

function fillOptions() {
  $('providerId').innerHTML = listProviders()
    .map((p) => `<option value="${p.id}">${t(p.label)}</option>`)
    .join('');
  $('presetId').innerHTML = presetOptions()
    .map((p) => `<option value="${p.id}">${t(p.label)}</option>`)
    .join('');
  fillLanguageOptions();
}

function fillLanguageOptions() {
  const select = $('targetLang');
  select.replaceChildren();
  const choices = [{ value: '', label: t('请选择用户语言') }, ...LANGUAGES];
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    select.append(option);
  }
}

function paintForm() {
  const target = form.saved.targetLang || '';
  if (target && ![...$('targetLang').options].some(option => option.value === target)) {
    const option = document.createElement('option');
    option.value = target;
    option.textContent = target;
    $('targetLang').append(option);
  }
  for (const id of ALL_FIELDS) formField(id).value = form.saved[id] ?? '';
  paintInterfaceLanguage();
  $('customColors').hidden = form.saved.translationColor !== 'custom';
  for (const id of LIVE_BOOL_FIELDS) $(id).checked = Boolean(form.saved[id]);
  paintProviderHint();
  paintPair();
  paintDetected();
  paintChips();
  paintCounter();
  paintPeeks();
  paintDisplaySegments();
  paintFabRow();
  paintConsistency(tabInfo?.state);
  paintRulesNote();
}

function paintInterfaceLanguage() {
  const language = uiLanguage();
  document.documentElement.lang = interfaceLanguage(language);
  localizeMarkup(document, language);
  $('targetLang').options[0].textContent = t('请选择用户语言');
  $('userLanguageNote').textContent = ['zh', 'en'].includes(normalizeLanguage(language))
    ? t('点击翻译后，统一翻译成所选语言。')
    : t('译文使用所选语言；此语言的界面暂用英文。');
  $('reveal').textContent = $('apiKey').type === 'password' ? t('显示') : t('隐藏');
  modelPicker.relabel();
  for (const [id, items] of [['providerId', listProviders()], ['presetId', presetOptions()]]) {
    for (const item of items) {
      const option = [...$(id).options].find(option => option.value === item.id);
      if (option) option.textContent = t(item.label);
    }
  }
}


function paintDisplaySegments() {
  const mode = $('displayMode')?.value || 'bilingual';
  document.querySelectorAll('#displaySegments .seg-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.dataset.active = active ? '1' : '0';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

let activeSettingsTab = 'model';

function showHome() {
  $('homeView').hidden = false;
  $('settingsView').hidden = true;
}

function showSettings(tab = activeSettingsTab) {
  const machine = activeProvider()?.kind === 'mt';
  const allowed = machine ? ['model', 'style', 'tools'] : ['model', 'style', 'rules', 'tools'];
  activeSettingsTab = allowed.includes(tab) ? tab : 'model';
  $('homeView').hidden = true;
  $('settingsView').hidden = false;
  document.querySelectorAll('#settingsTabs .settings-tab').forEach((btn) => {
    const active = btn.dataset.tab === activeSettingsTab;
    btn.dataset.active = active ? '1' : '0';
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.settings-panel[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== activeSettingsTab;
  });
  localStorage.setItem('byom-settings-tab', activeSettingsTab);
}

function activeProvider() {
  return listProviders().find((x) => x.id === $('providerId').value) || null;
}

function paintProviderHint() {
  // 用表单当前值而不是已保存的 settings：切换协议时提示要立刻跟着变
  const p = activeProvider();
  if (p?.fixedBase && $('apiBase').value !== p.defaultBase) $('apiBase').value = p.defaultBase;
  $('providerHint').textContent = p ? t(p.hint) : '';

  const link = $('keyLink');
  link.hidden = !p?.keyUrl;
  if (p?.keyUrl) link.href = p.keyUrl;
  $('modelNote').textContent = p?.modelHint ? t`例：${t(p.modelHint)}` : '';
  $('modelNote').dataset.tone = '';
  paintKeyNote();
  paintEngineVisibility(p);
}

function paintEngineVisibility(provider = activeProvider()) {
  const machine = provider?.kind === 'mt';
  $('apiBaseField').hidden = Boolean(provider?.fixedBase);
  $('apiKeyField').hidden = provider?.requiresKey === false;
  $('modelField').hidden = provider?.requiresModel === false;
  $('contextCard').hidden = machine;
  $('consistencyCard').hidden = machine;
  document.querySelectorAll('[data-llm-only]').forEach((node) => { node.hidden = machine; });
  const rulesTab = document.querySelector('.settings-tab[data-tab="rules"]');
  if (rulesTab) rulesTab.hidden = machine;
  $('settingsTabs').style.gridTemplateColumns = machine ? 'repeat(3, 1fr)' : '';

  $('machineModeNote').hidden = !machine;
  $('machineModeNote').textContent = machine
    ? t('基础翻译模式会把安全范围内的正文合并提交；超限分块时附带标题、章节和相邻原文。页面规则、预检与语义记忆不会生效。正文仍会发送给所选服务')
    : '';
  $('taskFootText').textContent = machine
    ? t('免 Key 基础翻译 · 安全范围内整页合并')
    : t('自动读取页面语境 · 安全范围内优先整页');
  $('wholePageNote').textContent = machine
    ? t`正文 ≤${(provider.wholePageMaxSourceChars || 4500).toLocaleString()} 字且 ≤${provider.wholePageMaxItems || 60} 段时整页合并；超限自动分块并附带邻接语境。关闭后始终分块`
    : t('按预计输入与输出 token 自动判断；单页最多 160 个单元，超限自动分块。关闭后始终分块');

  if (machine && activeSettingsTab === 'rules' && !$('settingsView').hidden) showSettings('model');
}

/** Key 格式只提示不拦截：各家随时可能换前缀，硬拦会把能用的 Key 挡在外面 */
function paintKeyNote() {
  const p = activeProvider();
  const note = $('keyNote');
  if (p?.requiresKey === false) {
    note.textContent = t(p.keyHint || t('这家不需要 Key'));
    note.dataset.tone = '';
    return;
  }
  const res = checkKey($('apiKey').value, { ...p, keyHint: t(p?.keyHint || '') }, t);
  if (res.level === 'empty') {
    note.textContent = p?.keyHint ? t`格式：${t(p.keyHint)}` : '';
    note.dataset.tone = '';
  } else {
    note.textContent = res.message || t('格式看起来没问题');
    note.dataset.tone = res.level === 'warn' ? 'warn' : 'ok';
  }
}

/** 地址纠错：把整条请求 URL 粘进来是最常见的错法，直接帮他改掉并说明改了什么 */
function fixBase() {
  const p = activeProvider();
  const { value, note } = normalizeBase($('apiBase').value, p, t);
  if (value !== $('apiBase').value) {
    $('apiBase').value = value;
    refreshDraft('model');
  }
  $('baseNote').textContent = note;
  $('baseNote').dataset.tone = note ? 'ok' : '';
}

async function onFetchModels() {
  const p = activeProvider();
  if (p?.requiresModel === false) return setStatus(t('这个基础翻译引擎没有模型列表'), '');
  if (!await ensurePermission()) return { ok: false, message: $('status').textContent };
  $('modelNote').textContent = t('正在拉取…');
  $('modelNote').dataset.tone = '';
  const request = currentModelDraft();
  const res = await runtimeReply({ type: MSG.LIST_MODELS, payload: { settingsOverride: request } })
    .catch(error => ({ ok: false, error: { message: error.message } }));
  const current = currentModelDraft();
  if (['providerId', 'apiBase', 'apiKey'].some(key => request[key] !== current[key])) {
    $('modelNote').textContent = t('模型配置已变化，请重新拉取列表');
    return { ok: false, message: $('modelNote').textContent };
  }
  if (!res?.ok || !Array.isArray(res.ids)) {
    $('modelNote').textContent = `${res?.error?.message || t('拉取失败')}${p?.modelHint ? t` · 例：${p.modelHint}` : ''}`;
    $('modelNote').dataset.tone = 'warn';
    return { ok: false, message: $('modelNote').textContent };
  }
  // 远端数据不进 innerHTML：中转站、自建网关都是本项目明确支持的场景，
  // 这类端点的可信度不高，而这里是装着 API Key 的特权页面
  modelPicker.replaceOptions(res.ids);
  $('modelNote').textContent = t`已拉到 ${res.ids.length} 个模型，请展开下拉框选择`;
  $('modelNote').dataset.tone = 'ok';
  $('model').focus();
  return setStatus($('modelNote').textContent, 'ok');
}

/** 折叠区收起时的摘要：全部读表单当前值，不是已保存值——这样"待应用"的改动也能看见 */
function paintFabRow() {
  $('fabPosRow').hidden = !$('floatButton').checked;
}

function paintConsistency(state = tabInfo?.state) {
  const note = $('consistencyNote');
  if (!note) return;
  const view = consistencyView(state?.consistencyTelemetry, $('semanticConsistency')?.checked, uiLanguage());
  note.textContent = view.text;
  note.title = view.title;
  const copy = $('copyConsistency');
  if (copy) copy.hidden = !view.copy;
}

async function onCopyConsistency() {
  const data = tabInfo?.state?.consistencyTelemetry;
  if (!data) return setStatus(t('还没有语义一致性观测数据'), 'warn');
  try {
    await waitForReply(navigator.clipboard.writeText(JSON.stringify(data, null, 2)));
    return setStatus(t('语义一致性数据已复制'), 'ok');
  } catch (error) {
    return setStatus(`${t('复制失败')}：${t(error?.message || '请确认浏览器允许写入剪贴板')}`, 'warn');
  }
}

async function onCopyDiagnostics() {
  if (!tabInfo) await refreshTab();
  try {
    const result = await copyPanelDiagnostics({ saved: form.saved, tab: tabInfo || {},
      hasPermission: await waitForReply(hasApiPermission(form.saved.apiBase)) });
    const status = setStatus(
      result.hadLog && !result.cleared ? t('诊断已复制；页面日志未能清空') : t('一次性诊断已复制，不含 Key 与页面正文'),
      result.hadLog && !result.cleared ? 'warn' : 'ok'
    );
    return { ...status, ok: true, tone: result.hadLog && !result.cleared ? 'warning' : 'success' };
  } catch (error) {
    return setStatus(`${t('复制失败')}：${t(error?.message || '请确认浏览器允许写入剪贴板')}`, 'warn');
  }
}

/** 验收取证：后台生命周期 + 当前页面日志，一次复制，两侧都不清空。 */
async function onCopyAcceptance() {
  if (!tabInfo) await refreshTab();
  try {
    const result = await copyAcceptanceLog({ saved: form.saved, tab: tabInfo || {},
      hasPermission: await waitForReply(hasApiPermission(form.saved.apiBase)) });
    const missing = result.backgroundEvents === null;
    const status = setStatus(missing ? t('页面诊断已复制；后台验收日志不可用') :
      t`验收日志已复制：后台 ${result.backgroundEvents} 条 · 页面 ${result.pageEvents} 条`, missing ? 'warn' : 'ok');
    return { ...status, ok: true, tone: missing ? 'warning' : 'success' };
  } catch (error) {
    return setStatus(`${t('复制失败')}：${t(error?.message || '请确认浏览器允许写入剪贴板')}`, 'warn');
  }
}

async function onClearAcceptance() {
  const ok = await clearAcceptanceLog();
  return setStatus(ok ? t('验收日志已清空，可以开始新一段取证') : t('清空失败，日志仍是原来的内容'), ok ? 'ok' : 'warn');
}

async function onCopyApiKey() {
  const value = $('apiKey').value;
  if (!value) return setStatus(t('当前模型没有可复制的 Key'), 'warn');
  try {
    await waitForReply(navigator.clipboard.writeText(value));
    return setStatus(t('API Key 已复制'), 'ok');
  } catch (error) {
    return setStatus(`${t('复制失败')}：${t(error?.message || '请确认浏览器允许写入剪贴板')}`, 'warn');
  }
}

/** 让"哪几家已经配好了"一眼可见，切换时心里有数 */
function paintAccounts() {
  const ids = Object.entries(form.saved.accounts || {})
    .filter(([id, account]) => {
      const provider = listProviders().find((p) => p.id === id);
      return provider?.requiresKey === false ? Boolean(account?.apiBase) : Boolean(account?.apiKey);
    })
    .map(([id]) => t(listProviders().find((p) => p.id === id)?.label || id));
  $('accountsHint').textContent = ids.length
    ? t`已保存 Key / 引擎配置：${ids.join('、')}（切换不会丢）`
    : '';
}


function paintPeeks() {
  const provider = activeProvider();
  const providerLabel = t(provider?.label || '');
  const detail = provider?.kind === 'mt' ? t('免 Key 基础翻译') : (modelPicker.value || t('未填模型'));
  $('peekModel').textContent = `${providerLabel} · ${detail}${formConfigured() ? '' : t(' · 待配置')}`;

  $('peekContext').textContent = contextPeek(tabInfo?.state || {}, $('presetId').value, uiLanguage());

  const mode = { bilingual: t('双语'), translation: t('仅译文'), original: t('仅原文') }[$('displayMode').value] || '';
  const style = { bar: t('左边线'), underline: t('虚线'), tint: t('淡背景'), plain: t('无标记') }[$('translationStyle').value] || '';
  $('peekStyle').textContent = `${mode}${style ? ` · ${style}` : ''}`;
}

function paintPair() {
  const live = tabInfo?.state;
  const activeId = live?.presetId || $('presetId')?.value || form.saved.presetId;
  const preset = presetOptions().find((p) => p.id === activeId);
  const target = languageLabel($('targetLang')?.value || form.saved.targetLang);
  $('pair').textContent = `${t(preset ? preset.label : activeId)} → ${target}`;
}

/**
 * 页面分类是背景信息，不是考试分数。fallback、画像很短、没有术语都属于正常情况；
 * 只有真正的请求/解析错误才应该用警告色。这里安静地告诉用户系统当前怎么处理本页。
 */
function paintDetected() {
  const live = tabInfo?.state;
  const el = $('detected');
  if (!live?.presetId) {
    el.textContent = form.saved.autoPreflight
      ? t('翻译时会自动读取整页语境')
      : t('当前按通用页面处理；需要时可在「页面规则」补充语境');
    el.dataset.tone = '';
    return;
  }

  const label = t(presetOptions().find((p) => p.id === live.presetId)?.label || live.presetId);
  const reason = t(PRESET_REASON[live.presetReason] || live.presetReason || '');
  const profile = live.profileYaml ? fromYaml(live.profileYaml) : null;
  const domain = profile?.domain?.slice(0, 2).join(' / ');

  if (domain) {
    el.textContent = `${domain}${reason && live.presetReason !== 'fallback' ? ` · ${reason}` : ''}`;
  } else if (live.presetReason === 'fallback') {
    el.textContent = t`当前按「${label}」处理；没有特殊语境也可以直接翻译`;
  } else {
    el.textContent = t`当前按「${label}」处理${reason ? ` · ${reason}` : ''}`;
  }
  el.dataset.tone = '';
}

/** 打开页面规则。它是可选的人工覆盖，不再承担“修正系统判断”的警告含义。 */
function jumpToRules() {
  if (activeProvider()?.kind === 'mt') {
    setStatus(t('免 Key 基础翻译不支持页面规则；切换到 LLM 引擎后可用'), '');
    return;
  }
  showSettings('rules');
  try {
    $('background').focus();
  } catch {
    /* 环境不支持聚焦时，切到规则页已经足够 */
  }
}

/* ---------------------------------- 设置生命周期 ---------------------------------- */

function updateApplyUi(group) {
  const dirty = form.changed(group);
  const button = group === 'model' ? $('applyModel') : $('applyRules');
  const note = group === 'model' ? $('modelApplyNote') : $('rulesApplyNote');
  if (button) button.disabled = actionPending(button) || !dirty;
  if (note) note.textContent = dirty ? t('有未应用修改') : '';
}

function refreshDraft(group) {
  if (form.changed(group)) resetActionFeedback(group === 'model' ? $('applyModel') : $('applyRules'));
  if (group === 'model') resetActionFeedback($('test'));
  updateApplyUi(group);
  refreshReadiness();
  paintPeeks();
  paintPair();
}

function currentModelDraft() {
  return form.readModel();
}

async function writeSettings(patch) {
  await form.write(patch);
  updateApplyUi('model');
  updateApplyUi('rules');
}

async function syncCurrentTab({ ensure = false } = {}) {
  if (!tabInfo?.tabId || !tabInfo.injectable) return false;
  if (!ensure && !tabInfo.injected) return false;
  const res = await runtimeReply({ type: MSG.SYNC_ON_TAB, payload: { tabId: tabInfo.tabId } })
    .catch(error => ({ ok: false, error: { message: error.message } }));
  if (tabInfo.injected && !res?.ok) throw new Error(t('设置已保存，但当前页面未能同步，请重试'));
  if (res?.ok && res.injected) tabInfo.injected = true;
  return Boolean(res?.ok && res.injected);
}

/**
 * LIVE 设置：storage 就是 active state。已有页面主动同步一次；未注入页面只有在需要
 * 悬浮球时才触发注入，避免改个颜色就往所有普通网页里塞 content script。
 */
async function saveLivePatch(patch, { ensureCurrentTab = false } = {}) {
  const key = Object.keys(patch)[0];
  const value = patch[key];
  const report = feedback.beginNotice('正在保存设置…');
  try {
    await writeSettings(patch);
    if ('apiBase' in patch) await refreshPermission();
    await syncCurrentTab({ ensure: ensureCurrentTab });
    paintPeeks();
    paintPair();
    refreshReadiness();
    const current = $(key)?.type === 'checkbox' ? $(key).checked : $(key)?.value;
    if (String(current) === String(value)) report('设置已保存');
    return form.saved;
  } catch {
    setStatus(t('设置保存失败，请重试这项设置；当前输入已保留'), 'warn');
    report('设置保存失败，请重试这项设置；当前输入已保留', 'error');
  }
}

function scheduleLivePatch(key, value, delay = 120, options = {}) {
  clearTimeout(liveTimers.get(key));
  const timer = setTimeout(() => {
    liveTimers.delete(key);
    void saveLivePatch({ [key]: value }, options);
  }, delay);
  liveTimers.set(key, timer);
}

async function applyModelSettings({ sync = true } = {}) {
  await form.applyModel();
  await refreshPermission();
  refreshDraft('model');
  paintProviderHint();
  paintAccounts();
  if (sync) await syncCurrentTab();
  return form.saved;
}

async function applyRulesSettings({ sync = true } = {}) {
  await form.applyRules();
  refreshDraft('rules');
  paintRulesNote();
  if (sync) await syncCurrentTab();
  return form.saved;
}

async function commitPendingSettings() {
  if (form.changed('model')) await applyModelSettings({ sync: false });
  if (form.changed('rules')) await applyRulesSettings({ sync: false });
  await syncCurrentTab({ ensure: Boolean(form.saved.floatButton) });
  return form.saved;
}

function currentHost() {
  try {
    return tabInfo?.url ? new URL(tabInfo.url).hostname : '';
  } catch {
    return '';
  }
}

function siteRuleForHost() {
  const host = currentHost();
  if (!host) return null;
  return (form.saved.siteRules || []).find(
    (r) => r?.host && (host === r.host.toLowerCase() || host.endsWith('.' + r.host.toLowerCase()))
  );
}

function paintChips() {
  const current = $('background').value.trim();
  $('bgChips').innerHTML = BG_TEMPLATES.map(
    (template, i) =>
      `<button type="button" class="chip" data-i="${i}" data-active="${
        current && t(template.text).startsWith(current.slice(0, 12)) ? '1' : '0'
      }" title="${t('填入模板后可继续改写')}">${t(template.label)}</button>`
  ).join('');
}

function paintCounter() {
  const n = $('background').value.length;
  $('bgCount').textContent = `${n} / 500`;
  $('bgCount').dataset.full = n >= 480 ? '1' : '0';
}

/** 让"这段话管哪儿"一眼可见：只管当前页，还是已经钉在整个站点上 */
function paintScope() {
  const rule = siteRuleForHost();
  $('siteAuto').checked = Boolean(rule?.auto);
  const host = currentHost();
  const scope = $('ctxScope');
  scope.textContent = rule ? t`已固定 · ${rule.host}` : t('仅本页');
  scope.dataset.pinned = rule ? '1' : '0';
  $('unpinSite').hidden = !rule;
  $('pinSite').textContent = rule ? t('更新本站规则') : t('固定到本站');
  $('pinSite').disabled = actionPending($('pinSite')) || !host;
}

/* ---------------------------------- 状态 ---------------------------------- */

/**
 * 工具与高级在设置视图里，而 #status 在首页视图，点按钮时它根本不在屏幕上。
 * 所以这一区的反馈必须落在按钮自身；setStatus 只作为首页可见时的补充。
 */
function setStatus(text, tone = '') {
  const el = $('status');
  el.textContent = t(text);
  el.dataset.tone = tone;
  return { ok: tone !== 'warn', message: t(text) };
}

function paintProgress(state) {
  const go = $('go');
  const pct = state?.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  $('goFill').style.width = state?.running || state?.phase === PHASE.DONE ? pct + '%' : '0%';

  if (state?.running && (state.phase === PHASE.TRANSLATING || state.phase === PHASE.SCANNING)) {
    go.dataset.state = 'running';
    $('goText').textContent = state.total ? t`翻译中 ${state.done} / ${state.total}` : t('扫描页面中');
  } else if (state?.phase === PHASE.DONE) {
    go.dataset.state = 'done';
    $('goText').textContent = t('重新扫描页面');
  } else if (state?.phase === PHASE.PARTIAL) {
    go.dataset.state = 'done';
    $('goText').textContent = t`继续翻译（${state.failed} 段失败）`;
  } else {
    go.dataset.state = 'idle';
    $('goText').textContent = t('翻译当前页面');
  }

  // 显示方式现在是设置，不是"对已有译文的操作"，所以不再随页面状态禁用
  const modeLabel = { bilingual: t('双语'), translation: t('仅译文'), original: t('仅原文') };
  $('toggle').textContent = t('显示：') + (modeLabel[state?.displayMode || form.saved.displayMode] || t('双语'));
  $('toggle').disabled = false;
}

async function refreshTab() {
  tabInfo = await runtimeReply({ type: MSG.QUERY_TAB, payload: {} });
  if (tabInfo?.cache) $('cacheCount').textContent = String(tabInfo.cache.entries);
  // 页面上双击过的那段原文正是最该拿去试的，自动带过来，不用手动复制
  if (tabInfo?.labSample && !$('labInput').value.trim()) $('labInput').value = tabInfo.labSample;
  paintProgress(tabInfo?.state);
  paintPair();
  paintDetected();
  paintProfile(tabInfo?.state);
  paintConsistency(tabInfo?.state);
  paintScope();
  refreshReadiness();
}

/** 主按钮按当前表单判断；点翻译时会自动提交尚未应用的模型/规则草稿。 */
function formConfigured() {
  const provider = activeProvider();
  const fields = ['targetLang'];
  if (provider?.requiresBase !== false) fields.push('apiBase');
  if (provider?.requiresKey !== false) fields.push('apiKey');
  if (provider?.requiresModel !== false) fields.push('model');
  return fields.every((id) => formField(id).value.trim());
}

async function ensurePermission() {
  if (permissionGranted) return true;
  const base = $('apiBase').value.trim();
  const origin = originPatternFromUrl(base);
  if (!origin) {
    setStatus(t('API 地址不是合法的 http(s) URL'), 'warn');
    return false;
  }
  // Call request before the first await, while the click still owns its user gesture.
  const granted = await waitForReply(chrome.permissions.request({ origins: [origin] }), 120000);
  if ($('apiBase').value.trim() !== base) {
    setStatus(t('API 地址已改变，请重新执行操作'), 'warn');
    return false;
  }
  permissionGranted = granted;
  if (!granted) setStatus(t('没有该域名的访问权限'), 'warn');
  return granted;
}

async function refreshPermission() {
  const base = $('apiBase').value.trim();
  const granted = await waitForReply(hasApiPermission(base));
  if ($('apiBase').value.trim() === base) permissionGranted = granted;
}

function refreshReadiness() {
  const ready = formConfigured();
  const injectable = tabInfo ? tabInfo.injectable : true;
  $('go').disabled = actionPending($('go')) || !ready || !injectable;

  if (!ready) return setStatus(t('先配置翻译引擎，然后就能翻译当前页'), '');
  if (!injectable) return setStatus(t('当前页面不允许注入脚本，换一个普通网页'), 'warn');
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    return setStatus(t`第一次使用会请求访问 ${origin} 的权限`, '');
  }
  if (tabInfo?.state?.phase === PHASE.ERROR) return setStatus(tabInfo.state.message || t('上次翻译出错'), 'warn');
  setStatus(t('准备就绪'), 'ok');
}

/* ---------------------------------- 动作 ---------------------------------- */

async function onGo() {
  if (await ensurePermission()) return startTranslation();
  return { ok: false, message: $('status').textContent };
}

async function startTranslation() {
  await commitPendingSettings();
  setStatus(t('正在启动'), '');
  const res = await runtimeReply({
    type: MSG.START_ON_TAB,
    payload: { tabId: tabInfo?.tabId }
  });
  if (!res?.ok) return setStatus(res?.error?.message || t('启动失败'), 'warn');
  await refreshTab();
  return setStatus(t('已开始，可以关掉这个面板'), 'ok');
}

async function onToggle() {
  const res = await runtimeReply({
    type: MSG.TOGGLE_ON_TAB,
    payload: { tabId: tabInfo?.tabId }
  });
  if (res?.ok) {
    const modeLabel = { bilingual: t('双语'), translation: t('仅译文'), original: t('仅原文') };
    $('toggle').textContent = t('显示：') + (modeLabel[res.mode] || t('双语'));
    return setStatus($('toggle').textContent, 'ok');
  }
  return setStatus(res?.error?.message || t('显示模式切换失败'), 'warn');
}

async function onTest() {
  if (await ensurePermission()) return runTest();
  return { ok: false, message: $('status').textContent };
}

async function runTest() {
  setStatus(t('正在测试…'), '');
  const draft = currentModelDraft();
  const res = await runtimeReply({
    type: MSG.TEST_CONNECTION,
    payload: { settingsOverride: draft }
  });
  if (JSON.stringify(draft) !== JSON.stringify(currentModelDraft())) {
    return setStatus(t('测试期间配置已改变，请按当前配置重新测试'), 'warn');
  }
  if (res?.ok) return setStatus(t`连接正常，引擎返回：${res.echoed}`, 'ok');
  else return setStatus(res?.error?.message || t('连接失败'), 'warn');
}

/** 把当前语境和背景钉在这个域名上，下次打开同一站点直接生效 */
async function onPinSite() {
  const host = currentHost();
  if (!host) return setStatus(t('当前页面没有可用的域名'), 'warn');

  if (form.changed('rules')) await applyRulesSettings({ sync: false });
  const presetId = $('presetId').value || tabInfo?.state?.presetId || form.saved.presetId;
  const rules = (form.saved.siteRules || []).filter((r) => r.host !== host);
  rules.push({
    host,
    presetId: presetId === 'auto' ? undefined : presetId,
    background: $('background').value.trim(),
    rulesText: $('rulesText').value.trim(),
    auto: $('siteAuto').checked
  });
  await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
  return setStatus(t`已固定到 ${host}，下次打开直接生效`, 'ok');
}

async function onUnpinSite() {
  const host = currentHost();
  const rules = (form.saved.siteRules || []).filter((r) => r.host !== host);
  await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
  return setStatus(t`已取消 ${host} 的固定规则`, 'ok');
}

/**
 * 大纲以树形摊开，而不是一句"锁定 5 词"的摘要。
 * 显示的是合并后真正生效的那一份，每项标出来源 —— 这样"某个词为什么被这么翻"答得上来。
 */
function currentProfileYaml() {
  return tabInfo?.state?.profileYaml || '';
}

function paintProfileYaml(yaml) {
  $('copyProfile').disabled = actionPending($('copyProfile')) || !yaml.trim();
  // 页面级翻译原则：一句祈使句，比"这页讲什么"更能约束输出
  const principle = yaml ? fromYaml(yaml).principle : '';
  $('pagePrinciple').textContent = principle ? t`本页原则：${principle}` : '';
  $('pagePrinciple').hidden = !principle;
  const auto = yaml ? fromYaml(yaml) : null;
  const user = fromYaml($('rulesText').value);
  const merged = mergeRules(auto, user);
  // 空的时候也渲染：renderRulesTree 会明确说明“当前没有额外翻译约束”，
  // 比藏起来强 —— 读区的职责就是把系统的判断如实摆出来
  $('rulesTree').innerHTML = renderRulesTree(merged, buildSources({ auto, user }), uiLanguage());
  $('adoptProfile').disabled = actionPending($('adoptProfile')) || !auto;
}

/**
 * 大纲状态如实汇报。
 * 之前只看 hasProfile，于是"预检跑过但一条规则都没得出"会被说成"已生成术语画像"，
 * 而树里却是空状态 —— 面板自己跟自己打架。
 */
function paintProfile(state) {
  paintProfileYaml(state?.profileYaml || '');
  const el = $('profileInfo');
  const yaml = (state?.profileYaml || '').trim();

  if (state?.hasProfile && yaml) {
    const n = fromYaml(yaml);
    const preferred = Object.keys(n.preferred).length;
    const risky = Object.keys(n.risky).length;
    const constraints = preferred + risky + n.keep.length;
    const snap = state?.preflightHash ? t` · 快照 ${state.preflightHash.slice(0, 8)}${state.preflightReused ? t('（复用）') : ''}` : '';
    el.textContent = constraints
      ? t`已读取页面语境 · ${preferred} 个术语建议 · ${risky} 个歧义提示${snap}`
      : t`已读取页面语境；当前没有额外建议${snap}`;
    el.dataset.tone = '';
  } else if (state?.hasProfile) {
    el.textContent = t('已读取页面语境；当前没有需要额外约束的内容。');
    el.dataset.tone = '';
  } else if (form.saved.autoPreflight) {
    el.textContent = t('翻译时会自动读取整页语境，仅在有价值时生成术语约束。');
    el.dataset.tone = '';
  } else {
    el.textContent = t('自动读取已关闭；仍可直接翻译，需要时可在「页面规则」补充语境。');
    el.dataset.tone = '';
  }
  paintPeeks();
}


/**
 * 自然语言 → 结构化规则。结果一定回填到可编辑的框里，不直接生效 ——
 * 转换器本身也是模型调用，会读错、会漏、会自作主张。
 */
/* ---------------------------------- 临时翻译 ---------------------------------- */


/**
 * 临时翻译：翻你填的这一段，带上本页当前的语境与规则。
 * 走的是和整页翻译相同的组装路径 —— 否则这里翻出来的和整页翻出来的会是两回事。
 */
async function onLabRun() {
  const text = $('labInput').value.trim();
  if (!text) return setStatus(t('先填一段要翻的内容'), 'warn');
  if (!await ensurePermission()) return { ok: false, message: $('status').textContent };
  const auto = currentProfileYaml() ? fromYaml(currentProfileYaml()) : null;
  const profile = mergeRules(auto, fromYaml($('rulesText').value));

  $('labNote').textContent = t('正在翻译…');
  $('labNote').dataset.tone = '';
  const res = await runtimeReply({
      type: MSG.LAB_TRANSLATE,
      payload: {
        text,
        profile,
        presetId: $('presetId').value || tabInfo?.state?.presetId || form.saved.presetId,
        background: $('background').value.trim(),
        customPrompt: $('customPrompt').value.trim(),
        settingsOverride: currentModelDraft(),
        context: { title: '', hostname: currentHost() }
      }
    })
    .catch(error => ({ ok: false, error: { message: error.message } }));

  if (!res?.ok) {
    $('labNote').textContent = res?.error?.message || t('翻译失败');
    $('labNote').dataset.tone = 'warn';
    return setStatus($('labNote').textContent, 'warn');
  }

  if ($('labInput').value.trim() !== text) return setStatus(t('试译期间原文已改变，请重新翻译'), 'warn');
  $('labOut').hidden = false;
  $('labResult').textContent = res.text;
  const tok = (res.usage?.input || 0) + (res.usage?.output || 0);
  $('labNote').textContent = tok ? t`本次约 ${tok} token。` : '';
  $('labNote').dataset.tone = 'ok';
  return setStatus(t('临时翻译已完成'), 'ok');
}

async function onConvertRules() {
  if (activeProvider()?.kind === 'mt') {
    return setStatus(t('免 Key 基础翻译不支持规则转换；切换到 LLM 引擎后可用'), '');
  }
  const text = $('background').value.trim();
  if (!text) return setStatus(t('先写一条需要补充的页面语境或术语要求'), 'warn');
  if (!await ensurePermission()) return { ok: false, message: $('status').textContent };
  setStatus(t('正在转换…'), '');
  const rulesBefore = $('rulesText').value;
  const res = await runtimeReply({
      type: MSG.CONVERT_RULES,
      payload: { text, settingsOverride: currentModelDraft(), context: { title: tabInfo?.state?.title || '', hostname: currentHost() } }
    })
    .catch(error => ({ ok: false, error: { message: error.message } }));
  if (!res?.ok) return setStatus(res?.error?.message || t('转换失败'), 'warn');

  if ($('background').value.trim() !== text || $('rulesText').value !== rulesBefore) {
    return setStatus(t('转换期间输入已改变，已保留当前草稿，请重新转换'), 'warn');
  }
  $('rulesText').value = res.yaml;
  paintRulesNote();
  refreshDraft('rules');
  return setStatus(t('已转成规则，核对无误后应用规则'), 'ok');
}

/** 手改之后当场校验：解析不出来要立刻知道，而不是等翻译时静默失效 */
function paintRulesNote() {
  const text = $('rulesText').value.trim();
  const note = $('rulesNote');
  if (!text) {
    note.textContent = t('留空则使用自动读取的页面语境。');
    note.dataset.tone = '';
    return;
  }
  const parsed = fromYaml(text);
  if (isEmptyRules(parsed)) {
    note.textContent = t('解析不出任何规则，检查一下格式（键名后要有冒号）。');
    note.dataset.tone = 'warn';
    return;
  }
  const n = Object.keys(parsed.hard).length;
  const p = Object.keys(parsed.preferred).length;
  const risky = Object.entries(parsed.risky);
  const withSense = risky.filter(([, sense]) => sense).length;
  note.textContent =
    t`解析到：锁定 ${n} 词 · 优先 ${p} 词 · 风险 ${risky.length} 个` +
    (risky.length ? t`（${withSense} 个已注明义项）` : '') +
    t` · 不翻 ${parsed.keep.length} 项`;
  note.dataset.tone = 'ok';
}

async function onPreflight() {
  if (activeProvider()?.kind === 'mt') {
    return setStatus(t('免 Key 基础翻译不支持页面预检；整页与邻接语境会直接随正文提交'), '');
  }
  if (!tabInfo?.tabId) return setStatus(t('先打开一个普通网页'), 'warn');
  if (!await ensurePermission()) return { ok: false, message: $('status').textContent };
  if (form.changed('model')) await applyModelSettings({ sync: false });
  setStatus(t('正在读取整页语境…'), '');
  // 独立通道：后台按需注入并直接触发预检，不依赖先跑一次翻译
  const res = await runtimeReply({
    type: MSG.PREFLIGHT_ON_TAB,
    payload: { tabId: tabInfo.tabId }
  });
  if (!res?.ok) return setStatus(res?.error?.message || t('读取页面语境失败'), 'warn');
  if (tabInfo) {
    tabInfo.state = {
      ...(tabInfo.state || {}),
      hasProfile: true,
      profileYaml: res.profileYaml || '',
      preflightHash: res.profileHash || '',
      preflightReused: Boolean(res.reused)
    };
  }
  paintProfileYaml(currentProfileYaml());
  $('profileInfo').textContent = preflightInfo(res.profile, res.profileHash, uiLanguage());
  $('profileInfo').dataset.tone = '';
  paintDetected();
  paintPeeks();
  return setStatus(t('页面语境已更新'), 'ok');
}

/** Copy the complete detected profile without merging drafts or changing rules. */
async function onCopyProfile() {
  const yaml = currentProfileYaml();
  if (!yaml.trim()) return setStatus(t('还没有可复制的页面语境，请先读取'), 'warn');
  try {
    await waitForReply(navigator.clipboard.writeText(yaml));
    return setStatus(t('完整页面语境已复制到剪贴板'), 'ok');
  } catch (error) {
    return setStatus(`${t('复制失败')}：${t(error?.message || '请确认浏览器允许写入剪贴板')}`, 'warn');
  }
}

/**
 * 把自动识别的画像倒进规则框。倒进去之后它就是"用户规则"，
 * 优先级从"模型猜的"升到"人定的"——所以必须是显式动作，不能自动发生。
 */
function onAdoptProfile() {
  const yaml = currentProfileYaml().trim();
  if (!yaml) return setStatus(t('还没有可复制的页面语境，请先读取'), 'warn');
  const existing = $('rulesText').value.trim();
  $('rulesText').value = existing ? `${existing}\n${yaml}` : yaml;
  paintRulesNote();
  refreshDraft('rules');
  jumpToRules();
  return setStatus(t('已复制到页面规则，改完后应用规则'), 'ok');
}

async function onExportMd() {
  if (!tabInfo?.tabId) return setStatus(t('先打开一个普通网页'), 'warn');
  const res = await tabReply(tabInfo.tabId, { type: MSG.EXPORT_MD }).catch(error => ({ ok: false, error: { message: error.message } }));
  if (!res?.ok) return setStatus(res?.error?.message || t('当前页面不可用，请刷新页面后重试'), 'warn');
  if (!res.markdown?.trim()) return setStatus(t('本页还没有已完成的译文'), 'warn');
  const blob = new Blob([res.markdown], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (tabInfo.url ? new URL(tabInfo.url).hostname : 'page') + '-bilingual.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return setStatus(t('已导出对照 Markdown'), 'ok');
}

async function onClearCache() {
  const res = await runtimeReply({ type: MSG.CLEAR_CACHE, payload: {} });
  if (!res?.ok) return setStatus(res?.error?.message || t('清空失败'), 'warn');
  $('cacheCount').textContent = String(res.cache?.entries ?? 0);
  return setStatus(t('翻译缓存已清空（页面语境保留）'), 'ok');
}

/**
 * 真正的"回到干净状态"：后台缓存 + 当前页画像一起清。
 */
async function onResetAll() {
  const res = await runtimeReply({ type: MSG.CLEAR_CACHE, payload: {} });
  if (!res?.ok) return setStatus(res?.error?.message || t('清空失败'), 'warn');
  $('cacheCount').textContent = String(res.cache?.entries ?? 0);
  let pageOk = false;
  if (tabInfo?.tabId) {
    const r = await tabReply(tabInfo.tabId, { type: MSG.RESET_PROFILE }).catch(error => ({ ok: false, error: { message: error.message } }));
    pageOk = Boolean(r?.ok);
  }
  return setStatus(
    pageOk ? t('缓存与本页语境都已清空') : tabInfo?.injected
      ? t('缓存已清空，但本页语境未能复位，请重试') : t('缓存已清空；当前页没有注入，无需复位语境'),
    !pageOk && tabInfo?.injected ? 'warn' : 'ok'
  );
}

/* ---------------------------------- 绑定 ---------------------------------- */

async function onSiteAutoChanged() {
  const rule = siteRuleForHost();
  if (!rule) { feedback.notice('固定到本站后生效'); return; }
  const host = currentHost();
  const rules = (form.saved.siteRules || []).map((r) =>
    r?.host === host ? { ...r, auto: $('siteAuto').checked } : r
  );
  const report = feedback.beginNotice('正在保存设置…');
  await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
  report('设置已保存');
}

/* ---------------------------------- 绑定 ---------------------------------- */

async function runAction(action) {
  try { await action(); }
  catch {
    setStatus(t('操作未完成，请重试；当前草稿已保留'), 'warn');
    feedback.notice('操作未完成，请重试；当前草稿已保留', 'error');
  }
}

const ACTIONS = {
  test: ['测试中…', '连接成功', '连接失败', 'test'],
  fetchModels: ['拉取中', '已获取', '拉取失败'],
  go: ['正在启动…', '已启动', '启动失败', 'page-start'],
  toggle: ['切换中…', '已切换', '切换失败'],
  preflight: ['读取中…', '已更新', '读取失败', 'preflight'],
  labRun: ['正在翻译…', '已完成', '翻译失败', 'lab'],
  convertRules: ['正在转换…', '已转换', '转换失败', 'rules'],
  applyModel: ['应用中…', '已应用', '应用失败', 'settings'],
  applyRules: ['应用中…', '已应用', '应用失败', 'rules'],
  pinSite: ['保存中…', '已固定', '保存失败', 'site'],
  unpinSite: ['移除中…', '已取消', '移除失败', 'site'],
  adoptProfile: ['填入中…', '已填入', '未完成'],
  exportMd: ['导出中…', '已导出', '导出失败'],
  clearCache: ['清理中…', '已清空', '清空失败', 'cache'],
  resetAll: ['清理中…', '已清空', '未完全清空', 'cache'],
  clearAcceptance: ['清理中…', '已清空', '清空失败', 'diagnostic-log']
};

function actionOptions(id) {
  const copy = id.startsWith('copy');
  const [pending, success, failure, group] = ACTIONS[id] ||
    (copy ? ['复制中', '已复制', '复制失败', 'clipboard'] : ['处理中…', '已完成', '未完成']);
  return { pending, success, failure, group, onSettled: () => {
    updateApplyUi('model');
    updateApplyUi('rules');
    if (id === 'go') refreshReadiness();
    if (id === 'copyProfile' || id === 'adoptProfile') $(id).disabled = !currentProfileYaml().trim();
  } };
}

function bindAction(id, action, event = 'click') {
  $(id).addEventListener(event, () => {
    if (event === 'click') void feedback.run($(id), action, actionOptions(id));
    else void runAction(action);
  });
}

async function init() {
  const style = document.createElement('style');
  style.textContent = ACTION_FEEDBACK_CSS;
  document.head.append(style);
  form = createSettingsForm(formField, await waitForReply(getSettings()));
  fillOptions();
  paintForm();
  await refreshPermission();
  updateApplyUi('model');
  updateApplyUi('rules');

  // -------------------------- transactional: model --------------------------
  for (const id of ['apiBase', 'apiKey', 'model', 'customModel']) {
    $(id).addEventListener('input', () => {
      if (id === 'apiBase') permissionGranted = false;
      refreshDraft('model');
    });
  }
  $('model').addEventListener('change', () => { modelPicker.changed(); refreshDraft('model'); });
  $('apiKey').addEventListener('input', paintKeyNote);
  $('apiKey').addEventListener('input', () => {
    resetActionFeedback($('copyApiKey'));
    $('copyApiKey').textContent = t('复制');
  });
  $('apiBase').addEventListener('blur', fixBase);
  $('apiBase').addEventListener('change', fixBase);

  bindAction('providerId', async () => {
    form.switchProvider($('providerId').value);
    permissionGranted = false;
    $('copyApiKey').textContent = t('复制');
    await refreshPermission();
    paintProviderHint();
    paintPeeks();
    $('baseNote').textContent = '';
    refreshDraft('model');
  }, 'change');

  bindAction('copyAcceptance', onCopyAcceptance);
  bindAction('clearAcceptance', onClearAcceptance);

  bindAction('applyModel', async () => {
    await applyModelSettings();
    return setStatus(form.changed('model') ? t('已保存提交的引擎设置，仍有未应用修改') : t('引擎设置已应用'), 'ok');
  });

  // -------------------------- transactional: rules --------------------------
  $('background').addEventListener('input', () => {
    paintCounter();
    paintChips();
    refreshDraft('rules');
  });
  $('rulesText').addEventListener('input', () => {
    paintRulesNote();
    paintProfileYaml(currentProfileYaml());
    refreshDraft('rules');
  });
  $('customPrompt').addEventListener('input', () => refreshDraft('rules'));
  bindAction('applyRules', async () => {
    await applyRulesSettings();
    return setStatus(form.changed('rules') ? t('已保存提交的规则，仍有未应用修改') : t('规则已应用'), 'ok');
  });

  $('bgChips').addEventListener('click', (e) => {
    const i = e.target?.dataset?.i;
    if (i === undefined) return;
    const box = $('background');
    box.value = t(BG_TEMPLATES[Number(i)].text);
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    feedback.notice('模板已填入，编辑后应用规则');
    paintCounter();
    paintChips();
    refreshDraft('rules');
  });

  // ------------------------------- live settings ----------------------------
  $('targetLang').addEventListener('change', () => {
    paintInterfaceLanguage();
    paintProviderHint();
    paintAccounts();
    paintProfile(tabInfo?.state);
    paintDetected();
    paintConsistency(tabInfo?.state);
    paintRulesNote();
    paintChips();
    paintCounter();
    paintProgress(tabInfo?.state);
    void saveLivePatch({ targetLang: $('targetLang').value.trim() });
  });

  for (const id of LIVE_SELECT_FIELDS) {
    $(id).addEventListener('change', () => {
      if (id === 'translationColor') $('customColors').hidden = $('translationColor').value !== 'custom';
      if (id === 'displayMode') paintDisplaySegments();
      void saveLivePatch({ [id]: $(id).value });
    });
  }

  for (const id of LIVE_BOOL_FIELDS) {
    $(id).addEventListener('change', () => {
      if (id === 'floatButton') paintFabRow();
      if (id === 'semanticConsistency') paintConsistency(tabInfo?.state);
      void saveLivePatch(
        { [id]: $(id).checked },
        { ensureCurrentTab: id === 'floatButton' && $(id).checked }
      );
    });
  }

  for (const id of LIVE_NUM_FIELDS) {
    $(id).addEventListener('change', () => {
      const n = Number($(id).value);
      if (Number.isFinite(n)) void saveLivePatch({ [id]: n });
    });
  }

  // 颜色与字体需要“边调边看”，但 storage + runtime 广播不需要跟每个键盘事件同频。
  for (const id of COLOR_FIELDS) {
    $(id).addEventListener('input', () => scheduleLivePatch(id, $(id).value, 80));
  }
  $('translationFont').addEventListener('input', () => {
    scheduleLivePatch('translationFont', $('translationFont').value.trim(), 180);
  });
  // selector 文本编辑时反复重扫页面很烦：失焦/确认输入时保存，不需要额外“应用”按钮。
  $('skipSelectors').addEventListener('change', () => {
    void saveLivePatch({ skipSelectors: $('skipSelectors').value.trim() });
  });

  bindAction('siteAuto', onSiteAutoChanged, 'change');

  // --------------------------------- actions ---------------------------------
  $('reveal').addEventListener('click', () => {
    const input = $('apiKey');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    $('reveal').textContent = shown ? t('显示') : t('隐藏');
    $('reveal').setAttribute('aria-pressed', String(!shown));
  });
  bindAction('copyApiKey', onCopyApiKey);

  bindAction('go', onGo);
  bindAction('toggle', onToggle);
  bindAction('test', onTest);
  bindAction('clearCache', onClearCache);
  bindAction('resetAll', onResetAll);
  bindAction('pinSite', onPinSite);
  bindAction('preflight', onPreflight);
  bindAction('copyProfile', onCopyProfile);
  bindAction('exportMd', onExportMd);
  bindAction('copyConsistency', onCopyConsistency);
  bindAction('copyDiagnostics', onCopyDiagnostics);
  bindAction('unpinSite', onUnpinSite);
  bindAction('fetchModels', onFetchModels);
  bindAction('convertRules', onConvertRules);
  bindAction('adoptProfile', onAdoptProfile);
  $('goCalibrate').addEventListener('click', jumpToRules);
  bindAction('labRun', onLabRun);

  $('openSettings').addEventListener('click', () => showSettings(activeSettingsTab));
  $('closeSettings').addEventListener('click', showHome);
  document.querySelectorAll('#settingsTabs .settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => showSettings(btn.dataset.tab));
  });
  document.querySelectorAll('#displaySegments .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if ($('displayMode').value === btn.dataset.mode) return;
      $('displayMode').value = btn.dataset.mode;
      $('displayMode').dispatchEvent(new window.Event('change', { bubbles: true }));
      paintDisplaySegments();
    });
  });

  activeSettingsTab = localStorage.getItem('byom-settings-tab') || 'model';
  if (formConfigured() || !$('targetLang').value) showHome();
  else showSettings('model');

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MSG.TAB_STATE) {
      if (tabInfo) tabInfo.state = msg.payload;
      paintProgress(msg.payload);
      paintPair();
      paintDetected();
      paintProfile(msg.payload);
      paintConsistency(msg.payload);
      if (msg.payload?.message) setStatus(msg.payload.message, msg.payload.phase === PHASE.ERROR ? 'warn' : '');
    }
  });

  paintVersion();
  await refreshTab();
  paintScope();
  paintAccounts();
}

/** 版本号只有 manifest 一个来源，避免多处手改后对不上。 */
function paintVersion() {
  const el = $('ver');
  if (!el) return;
  const v = chrome.runtime?.getManifest?.()?.version;
  if (!v) return;
  el.textContent = 'v' + v;
  el.title = 'Just Translate v' + v;
}

void runAction(init);

// 测试钩子：面板逻辑没有导出，集成测试只能从 window 上拿一个重绘入口
window.__byomRepaint = (state) => {
  if (state && tabInfo) tabInfo.state = state;
  paintDetected();
  paintProfile(tabInfo?.state);
  paintProgress(tabInfo?.state);
  paintConsistency(tabInfo?.state);
};
