import { MSG, PHASE, PRESET_REASON } from '../shared/constants.js';
import { getSettings, patchSettings } from '../shared/settings.js';
import { presetOptions } from '../prompt/presets.js';
import { listProviders } from '../shared/provider-catalog.js';
import { hasApiPermission, originPatternFromUrl } from '../shared/permissions.js';
import { checkKey, normalizeBase } from '../shared/provider-help.js';
import { fromYaml, isEmptyRules, mergeRules } from '../shared/rules-yaml.js';
import { buildSources, renderRulesTree } from '../shared/rules-tree.js';

const $ = (id) => document.getElementById(id);

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

let settings = null;
let tabInfo = null;
let dirtyGroups = { model: false, rules: false };
let modelDraftProviderId = '';
let modelDraftAccounts = {};
const liveTimers = new Map();
let settingsWriteChain = Promise.resolve();
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
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join('');
  $('presetId').innerHTML = presetOptions()
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join('');
}

function paintForm() {
  for (const id of ALL_FIELDS) $(id).value = settings[id];
  $('customColors').hidden = settings.translationColor !== 'custom';
  for (const id of LIVE_BOOL_FIELDS) $(id).checked = Boolean(settings[id]);
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
  activeSettingsTab = ['model', 'style', 'rules', 'tools'].includes(tab) ? tab : 'model';
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
  $('providerHint').textContent = p ? p.hint : '';
  $('modelHints').innerHTML = ((p && p.models) || [])
    .map((m) => `<option value="${m}"></option>`)
    .join('');

  const link = $('keyLink');
  link.hidden = !p?.keyUrl;
  if (p?.keyUrl) link.href = p.keyUrl;
  $('modelNote').textContent = p?.modelHint ? `例：${p.modelHint}` : '';
  $('modelNote').dataset.tone = '';
  paintKeyNote();
}

/** Key 格式只提示不拦截：各家随时可能换前缀，硬拦会把能用的 Key 挡在外面 */
function paintKeyNote() {
  const p = activeProvider();
  const note = $('keyNote');
  if (p?.requiresKey === false) {
    note.textContent = p.keyHint || '这家不需要 Key';
    note.dataset.tone = '';
    return;
  }
  const res = checkKey($('apiKey').value, p);
  if (res.level === 'empty') {
    note.textContent = p?.keyHint ? `格式：${p.keyHint}` : '';
    note.dataset.tone = '';
  } else {
    note.textContent = res.message || '格式看起来没问题';
    note.dataset.tone = res.level === 'warn' ? 'warn' : 'ok';
  }
}

/** 地址纠错：把整条请求 URL 粘进来是最常见的错法，直接帮他改掉并说明改了什么 */
function fixBase() {
  const p = activeProvider();
  const { value, note } = normalizeBase($('apiBase').value, p);
  if (value !== $('apiBase').value) {
    $('apiBase').value = value;
    markDirty('model');
  }
  $('baseNote').textContent = note;
  $('baseNote').dataset.tone = note ? 'ok' : '';
}

async function onFetchModels() {
  const p = activeProvider();
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    if (!origin) return setStatus('先填好 API 地址', 'warn');
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return setStatus('没有该域名的访问权限', 'warn');
    permissionGranted = true;
  }
  $('modelNote').textContent = '正在拉取…';
  $('modelNote').dataset.tone = '';
  const res = await chrome.runtime
    .sendMessage({ type: MSG.LIST_MODELS, payload: { settingsOverride: currentModelDraft() } })
    .catch(() => null);
  if (!res?.ok) {
    $('modelNote').textContent = `${res?.error?.message || '拉取失败'}${p?.modelHint ? ` · 例：${p.modelHint}` : ''}`;
    $('modelNote').dataset.tone = 'warn';
    return;
  }
  // 远端数据不进 innerHTML：中转站、自建网关都是本项目明确支持的场景，
  // 这类端点的可信度不高，而这里是装着 API Key 的特权页面
  const list = $('modelHints');
  list.textContent = '';
  for (const m of res.ids) {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  }
  $('modelNote').textContent = `已拉到 ${res.ids.length} 个模型，点输入框从列表里选`;
  $('modelNote').dataset.tone = 'ok';
  $('model').focus();
}

/** 折叠区收起时的摘要：全部读表单当前值，不是已保存值——这样"待应用"的改动也能看见 */
function paintFabRow() {
  $('fabPosRow').hidden = !$('floatButton').checked;
}

function paintConsistency(state = tabInfo?.state) {
  const note = $('consistencyNote');
  const copy = $('copyConsistency');
  if (!note) return;
  if (!$('semanticConsistency')?.checked) {
    note.textContent = '';
    note.title = '';
    if (copy) copy.hidden = true;
    return;
  }

  const data = state?.consistencyTelemetry;
  if (!data?.summary) {
    note.textContent = '已开启 · 只记录跨段变体与分类，不修改译文';
    note.title = '';
    if (copy) copy.hidden = true;
    return;
  }

  const s = data.summary;
  const coverage = (s.semanticExpectedOccurrences ?? s.expectedOccurrences) ? Math.round((s.semanticAlignmentRate ?? s.candidateAlignmentRate ?? s.coverage ?? 0) * 100) : 0;
  const suspects = (data.rows || [])
    .filter((row) => row.consistency === 'DRIFT' || row.taxonomy === 'UNKNOWN')
    .slice(0, 6)
    .map((row) => `${row.source}: ${row.variants.map((v) => v.target).join(' / ')} [${row.taxonomy}]`);

  note.textContent = `已观测 ${s.termsObserved || 0} 词 · 对齐 ${coverage}% · 固定项漂移 ${s.fixedDrift || 0} · 结构项 ${s.structural || 0} · 待判 ${s.unknown ?? 0}${suspects.length ? ` · ${suspects.join('；')}` : ''}`;
  note.title = JSON.stringify(data, null, 2);
  if (copy) copy.hidden = false;
}

async function onCopyConsistency() {
  const data = tabInfo?.state?.consistencyTelemetry;
  if (!data) return setStatus('还没有语义一致性观测数据', '');
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setStatus('语义一致性数据已复制', 'ok');
  } catch {
    setStatus('复制失败，请打开控制台读取页面状态', 'warn');
  }
}

async function onCopyApiKey() {
  const value = $('apiKey').value;
  if (!value) return setStatus('当前模型没有可复制的 Key', 'warn');
  try {
    await navigator.clipboard.writeText(value);
    $('copyApiKey').textContent = '已复制';
    setStatus('API Key 已复制', 'ok');
  } catch {
    setStatus('复制失败，请确认浏览器允许写入剪贴板', 'warn');
  }
}

/** 让"哪几家已经配好了"一眼可见，切换时心里有数 */
function paintAccounts() {
  const ids = Object.entries(settings.accounts || {})
    .filter(([, a]) => a?.apiKey)
    .map(([id]) => listProviders().find((p) => p.id === id)?.label || id);
  $('accountsHint').textContent = ids.length
    ? `已保存 Key 的服务商：${ids.join('、')}（切换不会丢）`
    : '';
}


function paintPeeks() {
  const providerLabel = listProviders().find((x) => x.id === $('providerId').value)?.label || '';
  $('peekModel').textContent = `${providerLabel} · ${$('model').value || '未填模型'}${
    formConfigured() ? '' : ' · 待配置'
  }`;

  const live = tabInfo?.state;
  const profile = live?.profileYaml ? fromYaml(live.profileYaml) : null;
  const domain = profile?.domain?.slice(0, 2).join(' / ');
  const preset = presetOptions().find((p) => p.id === (live?.presetId || $('presetId').value))?.label || '';
  $('peekContext').textContent = domain || (live?.hasProfile ? '已读取' : preset || '自动读取');

  const mode = { bilingual: '双语', translation: '仅译文', original: '仅原文' }[$('displayMode').value] || '';
  const style = { bar: '左边线', underline: '虚线', tint: '淡背景', plain: '无标记' }[$('translationStyle').value] || '';
  $('peekStyle').textContent = `${mode}${style ? ` · ${style}` : ''}`;
}

function paintPair() {
  const live = tabInfo?.state;
  const activeId = live?.presetId || $('presetId')?.value || settings.presetId;
  const preset = presetOptions().find((p) => p.id === activeId);
  const target = $('targetLang')?.value || settings.targetLang;
  $('pair').textContent = `${preset ? preset.label : activeId} → ${target}`;
}

/**
 * 页面分类是背景信息，不是考试分数。fallback、画像很短、没有术语都属于正常情况；
 * 只有真正的请求/解析错误才应该用警告色。这里安静地告诉用户系统当前怎么处理本页。
 */
function paintDetected() {
  const live = tabInfo?.state;
  const el = $('detected');
  if (!live?.presetId) {
    el.textContent = settings.autoPreflight
      ? '翻译时会自动读取整页语境'
      : '当前按通用页面处理；需要时可在「页面规则」补充语境';
    el.dataset.tone = '';
    return;
  }

  const label = presetOptions().find((p) => p.id === live.presetId)?.label || live.presetId;
  const reason = PRESET_REASON[live.presetReason] || live.presetReason || '';
  const profile = live.profileYaml ? fromYaml(live.profileYaml) : null;
  const domain = profile?.domain?.slice(0, 2).join(' / ');

  if (domain) {
    el.textContent = `${domain}${reason && live.presetReason !== 'fallback' ? ` · ${reason}` : ''}`;
  } else if (live.presetReason === 'fallback') {
    el.textContent = `当前按「${label}」处理；没有特殊语境也可以直接翻译`;
  } else {
    el.textContent = `当前按「${label}」处理${reason ? ` · ${reason}` : ''}`;
  }
  el.dataset.tone = '';
}

/** 打开页面规则。它是可选的人工覆盖，不再承担“修正系统判断”的警告含义。 */
function jumpToRules() {
  showSettings('rules');
  try {
    $('background').focus();
  } catch {
    /* 环境不支持聚焦时，切到规则页已经足够 */
  }
}

/* ---------------------------------- 设置生命周期 ---------------------------------- */

function updateApplyUi(group) {
  const dirty = Boolean(dirtyGroups[group]);
  const button = group === 'model' ? $('applyModel') : $('applyRules');
  const note = group === 'model' ? $('modelApplyNote') : $('rulesApplyNote');
  if (button) button.disabled = !dirty;
  if (note) note.textContent = dirty ? '有未应用修改' : '';
}

function markDirty(group) {
  dirtyGroups[group] = true;
  updateApplyUi(group);
  refreshReadiness();
  paintPeeks();
  paintPair();
}

function markClean(group) {
  dirtyGroups[group] = false;
  updateApplyUi(group);
}

function currentModelDraft() {
  return {
    providerId: $('providerId').value,
    apiBase: $('apiBase').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim()
  };
}

function rememberCurrentModelDraft() {
  if (!modelDraftProviderId) return;
  const draft = currentModelDraft();
  modelDraftAccounts[modelDraftProviderId] = {
    apiBase: draft.apiBase,
    apiKey: draft.apiKey,
    model: draft.model
  };
}

async function writeSettings(patch) {
  const run = settingsWriteChain.then(async () => {
    const next = await patchSettings(patch);
    settings = next;
    return next;
  });
  settingsWriteChain = run.catch(() => {});
  return run;
}

async function syncCurrentTab({ ensure = false } = {}) {
  if (!tabInfo?.tabId || !tabInfo.injectable) return false;
  if (!ensure && !tabInfo.injected) return false;
  const res = await chrome.runtime
    .sendMessage({ type: MSG.SYNC_ON_TAB, payload: { tabId: tabInfo.tabId } })
    .catch(() => null);
  if (res?.ok && res.injected) tabInfo.injected = true;
  return Boolean(res?.ok && res.injected);
}

/**
 * LIVE 设置：storage 就是 active state。已有页面主动同步一次；未注入页面只有在需要
 * 悬浮球时才触发注入，避免改个颜色就往所有普通网页里塞 content script。
 */
async function saveLivePatch(patch, { ensureCurrentTab = false } = {}) {
  settings = await writeSettings(patch);
  if ('apiBase' in patch) permissionGranted = await hasApiPermission(settings.apiBase);
  await syncCurrentTab({ ensure: ensureCurrentTab });
  paintPeeks();
  paintPair();
  refreshReadiness();
  return settings;
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
  rememberCurrentModelDraft();
  const draft = currentModelDraft();
  const accounts = {
    ...(settings.accounts || {}),
    ...modelDraftAccounts,
    [draft.providerId]: { apiBase: draft.apiBase, apiKey: draft.apiKey, model: draft.model }
  };
  settings = await writeSettings({
    providerId: draft.providerId,
    apiBase: draft.apiBase,
    apiKey: draft.apiKey,
    model: draft.model,
    accounts
  });
  modelDraftProviderId = draft.providerId;
  modelDraftAccounts = { ...accounts };
  permissionGranted = await hasApiPermission(settings.apiBase);
  markClean('model');
  paintProviderHint();
  paintAccounts();
  refreshReadiness();
  if (sync) await syncCurrentTab();
  return settings;
}

async function applyRulesSettings({ sync = true } = {}) {
  settings = await writeSettings({
    background: $('background').value.trim(),
    rulesText: $('rulesText').value.trim(),
    customPrompt: $('customPrompt').value.trim()
  });
  markClean('rules');
  paintRulesNote();
  if (sync) await syncCurrentTab();
  return settings;
}

async function commitPendingSettings() {
  if (dirtyGroups.model) await applyModelSettings({ sync: false });
  if (dirtyGroups.rules) await applyRulesSettings({ sync: false });
  await syncCurrentTab({ ensure: Boolean(settings.floatButton) });
  return settings;
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
  return (settings.siteRules || []).find(
    (r) => r?.host && (host === r.host.toLowerCase() || host.endsWith('.' + r.host.toLowerCase()))
  );
}

function paintChips() {
  const current = $('background').value.trim();
  $('bgChips').innerHTML = BG_TEMPLATES.map(
    (t, i) =>
      `<button type="button" class="chip" data-i="${i}" data-active="${
        current && t.text.startsWith(current.slice(0, 12)) ? '1' : '0'
      }" title="填入模板后可继续改写">${t.label}</button>`
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
  scope.textContent = rule ? `已固定 · ${rule.host}` : '仅本页';
  scope.dataset.pinned = rule ? '1' : '0';
  $('unpinSite').hidden = !rule;
  $('pinSite').textContent = rule ? '更新本站规则' : '固定到本站';
  $('pinSite').disabled = !host;
}

/* ---------------------------------- 状态 ---------------------------------- */

function setStatus(text, tone = '') {
  const el = $('status');
  el.textContent = text;
  el.dataset.tone = tone;
}

function paintProgress(state) {
  const go = $('go');
  const pct = state?.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  $('goFill').style.width = state?.running || state?.phase === PHASE.DONE ? pct + '%' : '0%';

  if (state?.running && (state.phase === PHASE.TRANSLATING || state.phase === PHASE.SCANNING)) {
    go.dataset.state = 'running';
    $('goText').textContent = state.total ? `翻译中 ${state.done} / ${state.total}` : '扫描页面中';
  } else if (state?.phase === PHASE.DONE) {
    go.dataset.state = 'done';
    $('goText').textContent = '重新扫描页面';
  } else if (state?.phase === PHASE.PARTIAL) {
    go.dataset.state = 'done';
    $('goText').textContent = `继续翻译（${state.failed} 段失败）`;
  } else {
    go.dataset.state = 'idle';
    $('goText').textContent = '翻译当前页面';
  }

  // 显示方式现在是设置，不是"对已有译文的操作"，所以不再随页面状态禁用
  const modeLabel = { bilingual: '双语', translation: '仅译文', original: '仅原文' };
  $('toggle').textContent = '显示：' + (modeLabel[state?.displayMode || settings.displayMode] || '双语');
  $('toggle').disabled = false;
}

async function refreshTab() {
  tabInfo = await chrome.runtime.sendMessage({ type: MSG.QUERY_TAB, payload: {} });
  if (tabInfo?.cache) $('cacheCount').textContent = `(${tabInfo.cache.entries})`;
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
  const needKey = activeProvider()?.requiresKey !== false;
  const fields = needKey ? ['apiBase', 'apiKey', 'model', 'targetLang'] : ['apiBase', 'model', 'targetLang'];
  return fields.every((id) => $(id).value.trim());
}

function refreshReadiness() {
  const ready = formConfigured();
  const injectable = tabInfo ? tabInfo.injectable : true;
  $('go').disabled = !ready || !injectable;

  if (!ready) return setStatus('先配置模型与 API，然后就能翻译当前页', '');
  if (!injectable) return setStatus('当前页面不允许注入脚本，换一个普通网页', 'warn');
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    return setStatus(`第一次使用会请求访问 ${origin} 的权限`, '');
  }
  if (tabInfo?.state?.phase === PHASE.ERROR) return setStatus(tabInfo.state.message || '上次翻译出错', 'warn');
  setStatus('准备就绪', 'ok');
}

/* ---------------------------------- 动作 ---------------------------------- */

function onGo() {
  if (permissionGranted) return startTranslation();

  // 同步发起，中间不能有 await
  const origin = originPatternFromUrl($('apiBase').value.trim());
  if (!origin) return setStatus('API 地址不是合法的 http(s) URL', 'warn');
  chrome.permissions.request({ origins: [origin] }).then((granted) => {
    if (!granted) return setStatus('没有该域名的访问权限，无法调用模型', 'warn');
    permissionGranted = true;
    startTranslation();
  });
}

async function startTranslation() {
  await commitPendingSettings();
  setStatus('正在启动', '');
  const res = await chrome.runtime.sendMessage({
    type: MSG.START_ON_TAB,
    payload: { tabId: tabInfo?.tabId }
  });
  if (!res?.ok) return setStatus(res?.error?.message || '启动失败', 'warn');
  setStatus('已开始，可以关掉这个面板', 'ok');
  refreshTab();
}

async function onToggle() {
  const res = await chrome.runtime.sendMessage({
    type: MSG.TOGGLE_ON_TAB,
    payload: { tabId: tabInfo?.tabId }
  });
  if (res?.ok) {
    const modeLabel = { bilingual: '双语', translation: '仅译文', original: '仅原文' };
    $('toggle').textContent = '显示：' + (modeLabel[res.mode] || '双语');
  }
}

function onTest() {
  if (permissionGranted) return runTest();
  const origin = originPatternFromUrl($('apiBase').value.trim());
  if (!origin) return setStatus('API 地址不是合法的 http(s) URL', 'warn');
  chrome.permissions.request({ origins: [origin] }).then((granted) => {
    if (!granted) return setStatus('没有该域名的访问权限', 'warn');
    permissionGranted = true;
    runTest();
  });
}

async function runTest() {
  setStatus('正在测试…', '');
  const res = await chrome.runtime.sendMessage({
    type: MSG.TEST_CONNECTION,
    payload: { settingsOverride: currentModelDraft() }
  });
  if (res?.ok) setStatus(`连接正常，模型回了：${res.echoed}`, 'ok');
  else setStatus(res?.error?.message || '连接失败', 'warn');
}

/** 把当前语境和背景钉在这个域名上，下次打开同一站点直接生效 */
async function onPinSite() {
  const host = currentHost();
  if (!host) return setStatus('当前页面没有可用的域名', 'warn');

  if (dirtyGroups.rules) await applyRulesSettings({ sync: false });
  const presetId = $('presetId').value || tabInfo?.state?.presetId || settings.presetId;
  const rules = (settings.siteRules || []).filter((r) => r.host !== host);
  rules.push({
    host,
    presetId: presetId === 'auto' ? undefined : presetId,
    background: $('background').value.trim(),
    rulesText: $('rulesText').value.trim(),
    auto: $('siteAuto').checked
  });
  settings = await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
  setStatus(`已固定到 ${host}，下次打开直接生效`, 'ok');
}

async function onUnpinSite() {
  const host = currentHost();
  const rules = (settings.siteRules || []).filter((r) => r.host !== host);
  settings = await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
  setStatus(`已取消 ${host} 的固定规则`, 'ok');
}

/**
 * 大纲以树形摊开，而不是一句"锁定 5 词"的摘要。
 * 显示的是合并后真正生效的那一份，每项标出来源 —— 这样"某个词为什么被这么翻"答得上来。
 */
let lastProfileYaml = '';

function paintProfileYaml(yaml) {
  lastProfileYaml = yaml || '';
  // 页面级翻译原则：一句祈使句，比"这页讲什么"更能约束输出
  const principle = yaml ? fromYaml(yaml).principle : '';
  $('pagePrinciple').textContent = principle ? `本页原则：${principle}` : '';
  $('pagePrinciple').hidden = !principle;
  const auto = yaml ? fromYaml(yaml) : null;
  const user = fromYaml($('rulesText').value);
  const merged = mergeRules(auto, user);
  // 空的时候也渲染：renderRulesTree 会明确说明“当前没有额外翻译约束”，
  // 比藏起来强 —— 读区的职责就是把系统的判断如实摆出来
  $('rulesTree').innerHTML = renderRulesTree(merged, buildSources({ auto, user }));
  $('adoptProfile').disabled = !auto;
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
    const snap = state?.preflightHash ? ` · 快照 ${state.preflightHash.slice(0, 8)}${state.preflightReused ? '（复用）' : ''}` : '';
    el.textContent = constraints
      ? `已读取页面语境 · ${preferred} 个术语建议 · ${risky} 个歧义提示${snap}`
      : `已读取页面语境；当前没有额外建议${snap}`;
    el.dataset.tone = '';
  } else if (state?.hasProfile) {
    el.textContent = '已读取页面语境；当前没有需要额外约束的内容。';
    el.dataset.tone = '';
  } else if (settings.autoPreflight) {
    el.textContent = '翻译时会自动读取整页语境，仅在有价值时生成术语约束。';
    el.dataset.tone = '';
  } else {
    el.textContent = '自动读取已关闭；仍可直接翻译，需要时可在「页面规则」补充语境。';
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
  if (!text) return setStatus('先填一段要翻的内容', 'warn');
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    if (!origin) return setStatus('先填好 API 地址', 'warn');
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return setStatus('没有该域名的访问权限', 'warn');
    permissionGranted = true;
  }
  const auto = lastProfileYaml ? fromYaml(lastProfileYaml) : null;
  const profile = mergeRules(auto, fromYaml($('rulesText').value));

  $('labNote').textContent = '正在翻译…';
  $('labNote').dataset.tone = '';
  const res = await chrome.runtime
    .sendMessage({
      type: MSG.LAB_TRANSLATE,
      payload: {
        text,
        profile,
        presetId: $('presetId').value || tabInfo?.state?.presetId || settings.presetId,
        background: $('background').value.trim(),
        customPrompt: $('customPrompt').value.trim(),
        settingsOverride: currentModelDraft(),
        context: { title: '', hostname: currentHost() }
      }
    })
    .catch(() => null);

  if (!res?.ok) {
    $('labNote').textContent = res?.error?.message || '翻译失败';
    $('labNote').dataset.tone = 'warn';
    return;
  }

  $('labOut').hidden = false;
  $('labResult').textContent = res.text;
  const tok = (res.usage?.input || 0) + (res.usage?.output || 0);
  $('labNote').textContent = tok ? `本次约 ${tok} token。` : '';
  $('labNote').dataset.tone = 'ok';
}

async function onConvertRules() {
  const text = $('background').value.trim();
  if (!text) return setStatus('先写一条需要补充的页面语境或术语要求', 'warn');
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    if (!origin) return setStatus('先填好 API 地址', 'warn');
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return setStatus('没有该域名的访问权限', 'warn');
    permissionGranted = true;
  }
  setStatus('正在转换…', '');
  const res = await chrome.runtime
    .sendMessage({
      type: MSG.CONVERT_RULES,
      payload: { text, settingsOverride: currentModelDraft(), context: { title: tabInfo?.state?.title || '', hostname: currentHost() } }
    })
    .catch(() => null);
  if (!res?.ok) return setStatus(res?.error?.message || '转换失败', 'warn');

  $('rulesText').value = res.yaml;
  paintRulesNote();
  markDirty('rules');
  setStatus('已转成规则，核对无误后应用规则', 'ok');
}

/** 手改之后当场校验：解析不出来要立刻知道，而不是等翻译时静默失效 */
function paintRulesNote() {
  const text = $('rulesText').value.trim();
  const note = $('rulesNote');
  if (!text) {
    note.textContent = '留空则使用自动读取的页面语境。';
    note.dataset.tone = '';
    return;
  }
  const parsed = fromYaml(text);
  if (isEmptyRules(parsed)) {
    note.textContent = '解析不出任何规则，检查一下格式（键名后要有冒号）。';
    note.dataset.tone = 'warn';
    return;
  }
  const n = Object.keys(parsed.hard).length;
  const p = Object.keys(parsed.preferred).length;
  const risky = Object.entries(parsed.risky);
  const withSense = risky.filter(([, sense]) => sense).length;
  note.textContent =
    `解析到：锁定 ${n} 词 · 优先 ${p} 词 · 风险 ${risky.length} 个` +
    (risky.length ? `（${withSense} 个已注明义项）` : '') +
    ` · 不翻 ${parsed.keep.length} 项`;
  note.dataset.tone = 'ok';
}

async function onPreflight() {
  if (!tabInfo?.tabId) return setStatus('先打开一个普通网页', 'warn');
  if (!permissionGranted) {
    const origin = originPatternFromUrl($('apiBase').value.trim());
    if (!origin) return setStatus('API 地址不是合法的 http(s) URL', 'warn');
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return setStatus('没有该域名的访问权限', 'warn');
    permissionGranted = true;
  }
  if (dirtyGroups.model) await applyModelSettings({ sync: false });
  setStatus('正在读取整页语境…', '');
  // 独立通道：后台按需注入并直接触发预检，不依赖先跑一次翻译
  const res = await chrome.runtime.sendMessage({
    type: MSG.PREFLIGHT_ON_TAB,
    payload: { tabId: tabInfo.tabId }
  });
  if (!res?.ok) return setStatus(res?.error?.message || '读取页面语境失败', 'warn');

  paintProfileYaml(res.profileYaml || '');
  if (tabInfo) {
    tabInfo.state = {
      ...(tabInfo.state || {}),
      hasProfile: true,
      profileYaml: res.profileYaml || '',
      preflightHash: res.profileHash || '',
      preflightReused: Boolean(res.reused)
    };
  }
  const preferred = Object.keys(res.profile.preferred || {}).length;
  const risky = Object.keys(res.profile.risky || {}).length;
  const constraints = preferred + risky + (res.profile.keep || []).length;
  const snap = res.profileHash ? ` · 快照 ${res.profileHash.slice(0, 8)}` : '';
  $('profileInfo').textContent = constraints
    ? `已读取页面语境 · ${preferred} 个术语建议 · ${risky} 个歧义提示${snap}`
    : `已读取页面语境；当前没有额外建议${snap}`;
  $('profileInfo').dataset.tone = '';
  paintDetected();
  paintPeeks();
  setStatus('页面语境已更新', 'ok');
}

/**
 * 把自动识别的画像倒进规则框。倒进去之后它就是"用户规则"，
 * 优先级从"模型猜的"升到"人定的"——所以必须是显式动作，不能自动发生。
 */
function onAdoptProfile() {
  const yaml = lastProfileYaml.trim();
  if (!yaml) return;
  const existing = $('rulesText').value.trim();
  $('rulesText').value = existing ? `${existing}\n${yaml}` : yaml;
  paintRulesNote();
  markDirty('rules');
  jumpToRules();
  setStatus('已复制到页面规则，改完后应用规则', 'ok');
}

async function onExportMd() {
  if (!tabInfo?.tabId) return;
  const res = await chrome.tabs.sendMessage(tabInfo.tabId, { type: MSG.EXPORT_MD }).catch(() => null);
  if (!res?.ok || !res.markdown.trim()) return setStatus('本页还没有已完成的译文', 'warn');
  const blob = new Blob([res.markdown], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (tabInfo.url ? new URL(tabInfo.url).hostname : 'page') + '-bilingual.md';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('已导出对照 Markdown', 'ok');
}

async function onClearCache() {
  const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE, payload: {} });
  $('cacheCount').textContent = `(${res?.cache?.entries ?? 0})`;
  setStatus('翻译缓存已清空（页面语境保留）', 'ok');
}

/**
 * 真正的"回到干净状态"：后台缓存 + 当前页画像一起清。
 */
async function onResetAll() {
  const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE, payload: {} });
  $('cacheCount').textContent = `(${res?.cache?.entries ?? 0})`;
  let pageOk = false;
  if (tabInfo?.tabId) {
    const r = await chrome.tabs.sendMessage(tabInfo.tabId, { type: MSG.RESET_PROFILE }).catch(() => null);
    pageOk = Boolean(r?.ok);
  }
  setStatus(
    pageOk ? '缓存与本页语境都已清空' : '缓存已清空；当前页没有注入，无需复位语境',
    'ok'
  );
}

/* ---------------------------------- 绑定 ---------------------------------- */

async function onSiteAutoChanged() {
  const rule = siteRuleForHost();
  if (!rule) return; // 尚未固定：这个开关会随“固定到本站”一起写入
  const host = currentHost();
  const rules = (settings.siteRules || []).map((r) =>
    r?.host === host ? { ...r, auto: $('siteAuto').checked } : r
  );
  settings = await writeSettings({ siteRules: rules });
  await syncCurrentTab();
  paintScope();
}

/* ---------------------------------- 绑定 ---------------------------------- */

async function init() {
  fillOptions();
  settings = await getSettings();
  modelDraftProviderId = settings.providerId;
  modelDraftAccounts = {
    ...(settings.accounts || {}),
    [settings.providerId]: {
      apiBase: settings.apiBase,
      apiKey: settings.apiKey,
      model: settings.model
    }
  };
  permissionGranted = await hasApiPermission(settings.apiBase);
  paintForm();
  markClean('model');
  markClean('rules');

  // -------------------------- transactional: model --------------------------
  for (const id of ['apiBase', 'apiKey', 'model']) {
    $(id).addEventListener('input', () => {
      if (id === 'apiBase') permissionGranted = false;
      markDirty('model');
    });
  }
  $('apiKey').addEventListener('input', paintKeyNote);
  $('apiKey').addEventListener('input', () => { $('copyApiKey').textContent = '复制'; });
  $('apiBase').addEventListener('blur', fixBase);
  $('apiBase').addEventListener('change', fixBase);

  $('providerId').addEventListener('change', async () => {
    rememberCurrentModelDraft();
    const nextId = $('providerId').value;
    modelDraftProviderId = nextId;
    const p = listProviders().find((x) => x.id === nextId);
    const next = modelDraftAccounts[nextId] || null;
    $('apiBase').value = next?.apiBase || p?.defaultBase || '';
    $('apiKey').value = next?.apiKey || '';
    $('copyApiKey').textContent = '复制';
    $('model').value = next?.model || p?.defaultModel || '';
    permissionGranted = await hasApiPermission($('apiBase').value.trim());
    paintProviderHint();
    paintPeeks();
    $('baseNote').textContent = '';
    markDirty('model');
  });

  $('applyModel').addEventListener('click', async () => {
    await applyModelSettings();
    setStatus('模型设置已应用', 'ok');
  });

  // -------------------------- transactional: rules --------------------------
  $('background').addEventListener('input', () => {
    paintCounter();
    paintChips();
    markDirty('rules');
  });
  $('rulesText').addEventListener('input', () => {
    paintRulesNote();
    paintProfileYaml(lastProfileYaml);
    markDirty('rules');
  });
  $('customPrompt').addEventListener('input', () => markDirty('rules'));
  $('applyRules').addEventListener('click', async () => {
    await applyRulesSettings();
    setStatus('规则已应用', 'ok');
  });

  $('bgChips').addEventListener('click', (e) => {
    const i = e.target?.dataset?.i;
    if (i === undefined) return;
    const box = $('background');
    box.value = BG_TEMPLATES[Number(i)].text;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    paintCounter();
    paintChips();
    markDirty('rules');
  });

  // ------------------------------- live settings ----------------------------
  $('targetLang').addEventListener('change', () => {
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

  $('siteAuto').addEventListener('change', () => void onSiteAutoChanged());

  // --------------------------------- actions ---------------------------------
  $('reveal').addEventListener('click', () => {
    const input = $('apiKey');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    $('reveal').textContent = shown ? '显示' : '隐藏';
  });
  $('copyApiKey').addEventListener('click', onCopyApiKey);

  $('go').addEventListener('click', onGo);
  $('toggle').addEventListener('click', onToggle);
  $('test').addEventListener('click', onTest);
  $('clearCache').addEventListener('click', onClearCache);
  $('resetAll').addEventListener('click', onResetAll);
  $('pinSite').addEventListener('click', onPinSite);
  $('preflight').addEventListener('click', onPreflight);
  $('exportMd').addEventListener('click', onExportMd);
  $('copyConsistency').addEventListener('click', onCopyConsistency);
  $('unpinSite').addEventListener('click', onUnpinSite);
  $('fetchModels').addEventListener('click', onFetchModels);
  $('convertRules').addEventListener('click', onConvertRules);
  $('adoptProfile').addEventListener('click', onAdoptProfile);
  $('goCalibrate').addEventListener('click', jumpToRules);
  $('labRun').addEventListener('click', onLabRun);

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
  if (formConfigured()) showHome();
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

init();

// 测试钩子：面板逻辑没有导出，集成测试只能从 window 上拿一个重绘入口
window.__byomRepaint = (state) => {
  if (state && tabInfo) tabInfo.state = state;
  paintDetected();
  paintProfile(tabInfo?.state);
  paintProgress(tabInfo?.state);
  paintConsistency(tabInfo?.state);
};
