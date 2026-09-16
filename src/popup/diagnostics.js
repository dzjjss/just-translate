import { waitForReply } from '../shared/action-feedback.js';
import { runtimeReply, tabReply } from '../shared/ui-request.js';
import { MSG, PHASE } from '../shared/constants.js';
import { listProviders } from '../shared/provider-catalog.js';
import { classifyDiagnosticError, sanitizeDiagnosticUrl, sanitizeDiagnosticValue } from '../shared/diagnostics.js';

function diagnosticPanelMeta(saved, tab, hasPermission) {
  const state = tab.state || {};
  const provider = listProviders().find(item => item.id === saved.providerId) || {};
  return sanitizeDiagnosticValue({
    engine: {
      providerId: saved.providerId || 'unknown',
      engineKind: provider.kind || 'unknown',
      endpoint: sanitizeDiagnosticUrl(saved.apiBase || ''),
      model: provider.requiresModel === false ? '' : saved.model || '',
      targetLang: saved.targetLang || ''
    },
    panel: {
      injectable: Boolean(tab.injectable),
      injected: Boolean(tab.injected),
      configured: Boolean(tab.configured),
      hasPermission: Boolean(hasPermission),
      phase: state.phase || 'unknown',
      total: Number(state.total) || 0,
      done: Number(state.done) || 0,
      failed: Number(state.failed) || 0,
      errorCategory: state.phase === PHASE.ERROR
        ? classifyDiagnosticError(state.message || '')
        : ''
    }
  });
}

function fallbackDiagnostic(tab) {
  const now = new Date().toISOString();
  return {
    format: 'just-translate-diagnostic/v1',
    generatedAt: now,
    startedAt: now,
    privacy: 'No API key, page text, translation text, prompt, response body, URL query or hash.',
    extension: { version: chrome.runtime.getManifest().version },
    page: { url: sanitizeDiagnosticUrl(tab.url || '') },
    eventCount: 1,
    events: [{
      n: 1,
      at: now,
      elapsedMs: 0,
      event: 'content-log-unavailable',
      details: { reason: tab.injectable ? 'content-not-ready' : 'page-not-injectable' }
    }]
  };
}

/**
 * 验收日志 = 后台生命周期事件 + 当前页面的一次性诊断 + 面板可见状态。
 * 与「复制本次诊断」的区别是它不清任何东西：同一段证据要能反复复制，
 * 页面刷新和后台回收之后也仍然拿得到。
 */
function reportedTotal(events, key, complete) {
  if (!complete || events.some(row => !Number.isSafeInteger(row.details?.[key]) || row.details[key] < 0)) return null;
  return events.reduce((total, row) => total + row.details[key], 0);
}

function restartObserved(lifecycle) {
  if (!lifecycle || lifecycle.unavailable) return null;
  const events = lifecycle.events || [];
  const epochs = new Set(events.map(row => row.details?.epoch).filter(Boolean));
  if (lifecycle.epoch) epochs.add(lifecycle.epoch);
  if (epochs.size > 1) return true;
  const anchored = events.some(row => ['capture-start', 'worker-start'].includes(row.event) && row.details?.epoch);
  return anchored && !lifecycle.droppedBefore && !lifecycle.writeFailures ? false : null;
}

function summarizeLogWindow(lifecycle) {
  const events = lifecycle?.events || [];
  const readable = Boolean(lifecycle && !lifecycle.unavailable);
  const complete = readable && !lifecycle.droppedBefore && !lifecycle.writeFailures;
  const count = name => readable ? events.filter(row => row.event === name).length : null;
  const chunks = events.filter(row => row.event === 'translate-chunk');
  const translations = events.filter(row => ['translate-chunk', 'translate-failed'].includes(row.event));
  const preflights = events.filter(row => ['preflight', 'preflight-failed'].includes(row.event));
  const requests = [...translations, ...preflights];
  return {
    incomplete: !complete,
    sessionOpens: count('session-open'),
    sessionExpired: count('session-expired'),
    sessionAborts: count('session-abort'),
    translateChunks: count('translate-chunk'),
    cacheHitChunks: readable ? chunks.filter(row => row.details?.wholePageCacheHit === true).length : null,
    translationRequests: reportedTotal(translations, 'requests', complete),
    preflightRequests: reportedTotal(preflights, 'requests', complete),
    providerRequests: reportedTotal(requests, 'requests', complete),
    failedUnits: reportedTotal(translations, 'failed', complete),
    failureCategories: [...new Set(requests.map(row => row.details?.failureCategory).filter(Boolean))]
  };
}

function summarizeCurrentPage(diagnostic, tab) {
  const runtime = diagnostic?.translationRuntime || {};
  const state = tab.state || {};
  const pageReadable = !(diagnostic?.events || []).some(row => row.event === 'content-log-unavailable');
  return {
    pageReconnects: pageReadable
      ? (diagnostic?.events || []).filter(row => row.event === 'session-reconnected').length
      : null,
    translateRequestCount: runtime.translateRequestCount ?? null,
    wholePageCacheHit: runtime.wholePageCacheHit ?? null,
    translationMode: runtime.translationMode || null,
    preflightHash: state.preflightHash || null,
    preflightReused: state.preflightReused ?? null
  };
}

function acceptanceSummary(lifecycle, diagnostic, tab) {
  const readable = Boolean(lifecycle && !lifecycle.unavailable);
  return {
    note: 'logWindow 汇总窗口内所有页面的翻译与预检，不含连接测试、模型列表和临时试译；currentPage 仅当前页面。null 表示证据或统计缺失，不等于零。重启证据不能证明原因是空闲回收。',
    workerStarts: readable ? (lifecycle.events || []).filter(row => row.event === 'worker-start').length : null,
    workerRestartObserved: restartObserved(lifecycle),
    currentEpoch: lifecycle?.epoch || null,
    logWindow: summarizeLogWindow(lifecycle),
    currentPage: summarizeCurrentPage(diagnostic, tab)
  };
}

export async function copyAcceptanceLog({ saved, tab = {}, hasPermission }) {
  const res = await runtimeReply({ type: MSG.GET_LIFECYCLE_LOG }).catch(() => null);
  const lifecycle = res?.ok ? res.lifecycle : null;
  // passive：这次读取不往页面日志里记 log-exported，复制多少次都不污染证据。
  const page = tab.tabId
    ? await tabReply(tab.tabId, { type: MSG.GET_DIAGNOSTICS, payload: { passive: true } })
      .catch(() => null)
    : null;
  const diagnostic = (page?.ok && page.diagnostic) || fallbackDiagnostic(tab);
  const bundle = {
    format: 'just-translate-acceptance/v2',
    generatedAt: new Date().toISOString(),
    ...diagnosticPanelMeta(saved, tab, hasPermission),
    acceptance: acceptanceSummary(lifecycle, diagnostic, tab),
    background: lifecycle || { unavailable: true },
    pageDiagnostic: diagnostic
  };
  await waitForReply(navigator.clipboard.writeText(JSON.stringify(bundle, null, 2)));
  return { backgroundEvents: lifecycle?.eventCount ?? null, pageEvents: diagnostic.eventCount || 0 };
}

export async function clearAcceptanceLog() {
  const res = await runtimeReply({ type: MSG.CLEAR_LIFECYCLE_LOG });
  return Boolean(res?.ok);
}

/** A copy is a snapshot. Only its watermark is cleared after clipboard success. */
export async function copyPanelDiagnostics({ saved, tab = {}, hasPermission }) {
  const tabId = tab.tabId;
  const res = tabId
    ? await tabReply(tabId, { type: MSG.GET_DIAGNOSTICS }).catch(() => null)
    : null;
  const contentLog = res?.ok && res.diagnostic;
  const diagnostic = { ...(contentLog || fallbackDiagnostic(tab)),
    ...diagnosticPanelMeta(saved, tab, hasPermission) };
  await waitForReply(navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2)));
  const clear = contentLog
    ? await tabReply(tabId, { type: MSG.CLEAR_DIAGNOSTICS, payload: {
      logId: contentLog.logId, throughSequence: contentLog.throughSequence
    } }).catch(() => null)
    : null;
  return { hadLog: Boolean(contentLog), cleared: Boolean(clear?.ok) };
}
