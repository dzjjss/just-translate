import { waitForReply } from '../shared/action-feedback.js';
import { runtimeReply } from '../shared/ui-request.js';
import { DEFAULT_SETTINGS, LIMITS, MSG, PHASE, PROMPT_VERSION } from '../shared/constants.js';
import { setDebug, log } from '../shared/logger.js';
import {
  classifyDiagnosticError,
  createDiagnosticLog,
  sanitizeDiagnosticUrl
} from '../shared/diagnostics.js';
import { presetOptions } from '../prompt/presets.js';
import { collectPageContext, inspectExtraction, resetIds, scan } from './extractor.js';
import { buildPlainDigest, buildBilingualMarkdown } from './digest.js';
import { detectGlossaryDrift } from './quality.js';
import { mergeRules, normalizeRules, softenAutoRules, toYaml } from '../shared/rules-yaml.js';
import { createMutationWatcher, isNearViewport } from './observer.js';
import * as render from './renderer.js';
import * as hud from './hud.js';
import * as fab from './float-widget.js';
import { createPageSession } from './session.js';
import { createTranslationScheduler } from './translation-scheduler.js';
import { resolvePageContext } from './page-context.js';
import { classifyRuntimeConfigChange } from '../shared/settings.js';
import {
  createTermTelemetry,
  extractRepeatedSourceTerms,
  profileSourceCoverage,
  matchTrackedTermRows,
  selectTrackedTermRows
} from './term-consistency.js';
import { createSemanticMemory } from './semantic-memory.js';
import { hashString } from '../shared/hash.js';
import { buildMachineContext } from './machine-context.js';
import { requestSession } from './connection.js';
import { normalizeBatchOutcome, usageSummary } from '../shared/batch-outcome.js';
import { translateUi } from '../shared/ui-language.js';
import { browserUserLanguage } from '../shared/languages.js';

/**
 * 页面侧控制器。它拥有 DOM 与调度，但完全不知道 API Key、供应商、prompt 长什么样。
 * 与后台的契约只有一条消息：TRANSLATE_CHUNK。
 */

const app = {
  get running() { return page.isRunning(); },
  phase: PHASE.IDLE,
  config: null,
  pageConfig: null,
  context: null,
  presetId: 'general',
  presetReason: 'fallback',
  background: '',
  userRules: null,
  preflightSnapshot: null
};
const t = (...args) => translateUi(app.config?.targetLang || browserUserLanguage(), ...args);

let page = createPageSession();
let scheduler = null;
let mutationWatcher = null;
let statusTimer = null;
let heartbeatTimer = null;
let repeatedSourceTerms = [];
let consistencyTelemetry = createTermTelemetry();
let semanticMemory = createSemanticMemory({ enabled: false });
let translationRuntime = createTranslationRuntime();
let diagnostics = createDiagnosticLog();
let diagnosticRequestSequence = 0;

function createTranslationRuntime() {
  return {
    translationMode: null,
    modeReason: null,
    sourceChars: 0,
    unitCount: 0,
    budgetMode: null,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 0,
    translateRequestCount: 0,
    splitRetryCount: 0,
    wholePageCacheHit: false,
    boundaryRecoveryCount: 0,
    invalidResponseSplitCount: 0,
    invalidResponseFailedUnits: 0,
    sourceLimitFailedUnits: 0,
    recoveredContext: false,
    machineContextChars: 0,
    cachedUnitsExcludedFromObservation: 0
  };
}

function absorbTranslationRuntime(runtime = {}) {
  translationRuntime.translateRequestCount += Number(runtime?.translateRequestCount) || 0;
  translationRuntime.splitRetryCount += Number(runtime?.splitRetryCount) || 0;
  translationRuntime.wholePageCacheHit =
    translationRuntime.wholePageCacheHit || Boolean(runtime?.wholePageCacheHit);
  translationRuntime.boundaryRecoveryCount += Number(runtime?.boundaryRecoveryCount) || 0;
  translationRuntime.invalidResponseSplitCount += Number(runtime?.invalidResponseSplitCount) || 0;
  translationRuntime.invalidResponseFailedUnits += Number(runtime?.invalidResponseFailedUnits) || 0;
  translationRuntime.machineContextChars += Number(runtime?.machineContextChars) || 0;
  translationRuntime.sourceLimitFailedUnits += Number(runtime.sourceLimitFailedUnits) || 0;
  translationRuntime.recoveredContext ||= Boolean(runtime.recoveredContext);
}

function translationStats() {
  const { input, output, incomplete } = page.usageByPhase.translate;
  return { ...translationRuntime, tokenScope: 'translation', tokens: { input, output }, usageIncomplete: incomplete };
}

function recordDiagnostic(event, details = {}) {
  diagnostics.record(event, details);
}

function profileSummary(profile = page.profile) {
  const normalized = normalizeRules(profile);
  return {
    domains: normalized.domain.length,
    hard: Object.keys(normalized.hard).length,
    preferred: Object.keys(normalized.preferred).length,
    risky: Object.keys(normalized.risky).length,
    keep: normalized.keep.length
  };
}

/**
 * 一次性诊断复制走"导出即交接"语义，所以留一条 log-exported 作为水位。
 * 验收日志是被动快照，可以反复复制：它不记事件，否则每复制一次就往环形日志里
 * 塞一条噪声，把真正的事件挤出去。
 */
function exportDiagnostics(payload = {}) {
  if (!payload?.passive) {
    recordDiagnostic('log-exported', { phase: app.phase, eventCountBeforeExport: diagnostics.size });
  }
  return diagnosticSnapshot();
}

function diagnosticSnapshot() {
  const config = app.config || {};
  const preflight = app.preflightSnapshot || {};
  const consistency = app.config?.semanticConsistency ? consistencySnapshot()?.summary || null : null;
  return diagnostics.snapshot({
    extension: {
      version: chrome.runtime.getManifest?.().version || 'unknown',
      promptVersion: PROMPT_VERSION
    },
    page: {
      url: sanitizeDiagnosticUrl(location.href),
      titleChars: document.title.length
    },
    session: {
      id: page.id,
      active: page.isActive(),
      running: app.running,
      phase: app.phase,
      total: page.total,
      done: page.done,
      failed: page.failed,
      inflight: scheduler?.inflight || 0
    },
    config: {
      engineKind: config.engineKind || 'unknown',
      targetLang: config.targetLang || '',
      presetId: app.presetId,
      presetReason: app.presetReason,
      wholePageTranslation: Boolean(config.wholePageTranslation),
      autoPreflight: Boolean(config.autoPreflight),
      useCache: Boolean(config.useCache),
      concurrency: Number(config.concurrency) || 0,
      semanticConsistency: Boolean(config.semanticConsistency),
      semanticPrecedent: Boolean(config.semanticPrecedent),
      contentRootOnly: Boolean(config.contentRootOnly),
      smartFilter: Boolean(config.smartFilter),
      maxCharsPerChunk: Number(config.maxCharsPerChunk) || 0
    },
    preflight: {
      hasProfile: Boolean(page.profile),
      hash: preflight.hash || '',
      reused: Boolean(preflight.reused),
      ...profileSummary()
    },
    translationRuntime: translationStats(),
    extraction: inspectExtraction(document.body, app.pageConfig || config),
    usageByPhase: page.usageByPhase,
    consistency,
    semanticMemory: semanticMemory.stats()
  });
}

function clearDiagnosticLog(token = {}) {
  if (!diagnostics.clearThrough(token.logId, token.throughSequence)) return false;
  recordDiagnostic('log-cleared', { phase: app.phase, running: app.running });
  return true;
}

function makeScheduler(session) {
  return createTranslationScheduler({
    session,
    maxChars: app.config?.maxCharsPerChunk,
    wholePage: app.config?.wholePageTranslation,
    wholePageUseTokenEstimate: app.config?.engineKind !== 'mt',
    wholePageMaxSourceChars: app.config?.wholePageMaxSourceChars,
    wholePageMaxItems: app.config?.wholePageMaxItems,
    send: sendChunk,
    // 视口附近的段优先出队。这是取批瞬间的一次几何读取，不是登记状态。
    priority: (unit) => isNearViewport(unit.el),
    onPhase: (phase) => {
      if (session === page && session.isActive()) setPhase(phase);
    },
    onStatus: () => {
      if (session === page && session.isActive()) pushStatus();
    },
    onWork: () => {
      if (session === page && !heartbeatTimer) startHeartbeat();
    },
    onIdle: () => {
      if (session !== page || !session.isActive() || !app.running) return;
      runDriftCheck(session);
      setPhase(session.failed ? PHASE.PARTIAL : PHASE.DONE);
      stopHeartbeat();
    },
    log
  });
}

/**
 * 唯一的页面会话切换入口。旧 session 先失效，再创建新对象；所有旧 async 操作捕获
 * 的仍是旧对象，因此无法把结果写进新页。SPA、重翻、语义配置变化都走这里。
 */
function openPageSession({ abortPrevious = true, reason = 'new-session' } = {}) {
  const running = app.running;
  const previous = page;
  if (previous?.isActive()) {
    if (abortPrevious && previous.id) {
      chrome.runtime
        .sendMessage({ type: MSG.ABORT_SESSION, payload: { sessionId: previous.id } })
        .catch(() => {});
    }
    previous.invalidate();
  }
  scheduler?.stop();
  page = createPageSession();
  if (running) page.start();
  repeatedSourceTerms = [];
  consistencyTelemetry = createTermTelemetry();
  semanticMemory = createSemanticMemory({ enabled: Boolean(app.config?.semanticPrecedent) });
  translationRuntime = createTranslationRuntime();
  diagnostics = createDiagnosticLog();
  diagnosticRequestSequence = 0;
  recordDiagnostic('session-open', { reason });
  scheduler = makeScheduler(page);
  return page;
}

/* ---------------------------------- 调度接线 ---------------------------------- */

function enqueue(units) {
  const accepted = [];
  for (const unit of units) {
    if (!render.attach(unit)) continue; // 节点已脱离文档
    page.registerUnit(unit);
    accepted.push(unit);
  }
  if (accepted.length) {
    recordDiagnostic('units-enqueued', {
      discovered: units.length,
      accepted: accepted.length,
      sourceChars: accepted.reduce((sum, unit) => sum + String(unit.text || '').length, 0),
      total: page.total
    });
  }
  scheduler?.enqueue(accepted);
  pushStatus();
}

function refreshRepeatedSourceTerms(extraUnits = []) {
  if (!app.config?.semanticConsistency && !app.config?.semanticPrecedent) {
    repeatedSourceTerms = [];
    return;
  }
  // 这张源词表同时服务一致性 telemetry 与可选的 session precedent memory。
  // 只看源文，纯本地统计；关闭观测与 precedent 时也不会额外请求模型。
  const all = [...page.units.values(), ...(extraUnits || [])];
  repeatedSourceTerms = extractRepeatedSourceTerms(all);
  log('跨 chunk 源词候选：', repeatedSourceTerms.map((x) => `${x.term}×${x.units}`).slice(0, 24));
}

function planObservation(session, chunk) {
  const memoryRows = app.config.semanticPrecedent
    ? matchTrackedTermRows(repeatedSourceTerms.filter(row => row.kind === 'lexical'), chunk, { maxTerms: 8 }) : [];
  const consistencyRows = app.config.semanticConsistency
    ? selectTrackedTermRows(consistencyCandidatePool(session), chunk, {
        maxTerms: LIMITS.MAX_TRACKED_TERMS, minLexicalTerms: LIMITS.MIN_TRACKED_LEXICAL_TERMS
      }) : [];
  const rows = new Map();
  for (const row of [...consistencyRows, ...memoryRows]) rows.set(row.lemma || row.term, row);
  return {
    memoryRows, consistencyRows,
    trackedTerms: [...rows.values()].slice(0, LIMITS.MAX_TRACKED_TERMS).map(row => row.term),
    memoryHints: app.config.semanticPrecedent ? semanticMemory.hintsFor(chunk, memoryRows) : []
  };
}

function recordMode(options) {
  if (!options.modeReason || translationRuntime.translationMode) return;
  const fields = ['modeReason', 'sourceChars', 'unitCount', 'budgetMode',
    'estimatedInputTokens', 'estimatedOutputTokens', 'estimatedTotalTokens'];
  for (const key of fields) translationRuntime[key] = options[key];
  translationRuntime.translationMode = options.wholePage ? 'whole-page' : 'chunked';
  recordDiagnostic('mode-selected', Object.fromEntries(
    ['translationMode', ...fields].map(key => [key, translationRuntime[key]])
  ));
}

function prepareBatch(session, chunk, options) {
  recordMode(options);
  const observation = planObservation(session, chunk);
  const sectionPath = chunk[0]?.path || '';
  const mtContext = app.config.engineKind === 'mt' && !options.wholePage
    ? buildMachineContext({ units: [...session.units.values()], chunk, title: app.context?.title || '', sectionPath }) : '';
  const context = {
    ...app.context, presetId: app.presetId, background: app.background,
    profile: effectiveProfile(session), preflightSuggestions: preflightSuggestions(session),
    trackedTerms: observation.trackedTerms, semanticMemory: observation.memoryHints,
    sectionPath, wholePage: Boolean(options.wholePage), mtContext
  };
  const requestId = ++diagnosticRequestSequence;
  const payload = {
    sessionId: session.id, bypassCache: Boolean(options.bypassCache || session.bypassCache),
    items: chunk.map(unit => ({ i: unit.id, text: unit.text })), context
  };
  recordDiagnostic('translate-request', {
    requestId, units: chunk.length, sourceChars: chunk.reduce((sum, unit) => sum + unit.text.length, 0),
    wholePage: context.wholePage, bypassCache: payload.bypassCache,
    trackedTerms: observation.trackedTerms.length, memoryHints: observation.memoryHints.length,
    machineContextChars: mtContext.length
  });
  return { requestId, payload, observation };
}

function observeCommitted(unit, item, observation) {
  if (item.cached) {
    if (app.config.semanticConsistency || app.config.semanticPrecedent) {
      translationRuntime.cachedUnitsExcludedFromObservation++;
    }
    return;
  }
  const entry = { unit, translation: item.t, alignments: item.a || null };
  if (app.config.semanticPrecedent && observation.memoryRows.length) {
    semanticMemory.recordHintOutcomes({ ...entry, hints: observation.memoryHints });
    semanticMemory.observe({ ...entry, candidates: observation.memoryRows });
  }
  if (app.config.semanticConsistency && observation.consistencyRows.length) {
    consistencyTelemetry.record({ ...entry, candidates: observation.consistencyRows });
  }
}

function commitBatch(session, chunk, attempts, outcome, observation) {
  reconcilePage(session);
  const byId = new Map(outcome.items.map(item => [item.i, item]));
  const failed = new Set(outcome.failed);
  const message = outcome.error?.message || t('模型没有返回这一段');
  for (const unit of chunk) {
    const item = byId.get(unit.id);
    const succeeded = Boolean(item) && !failed.has(unit.id);
    const committed = session.commit(unit, attempts.get(unit.id), succeeded ? 'done' : 'error',
      () => succeeded ? render.fill(unit, item.t) : render.fail(unit, message, app.config?.targetLang));
    if (!committed || !succeeded) continue;
    session.addCachedItems([item]);
    observeCommitted(unit, item, observation);
  }
}

function reportBatch(session, batch, outcome) {
  session.addUsage(outcome.usage, 'translation', outcome.runtime.usageIncomplete);
  absorbTranslationRuntime(outcome.runtime);
  recordDiagnostic(outcome.ok ? 'translate-result' : 'translate-error', {
    requestId: batch.requestId, requested: batch.payload.items.length,
    returned: outcome.items.length, failed: outcome.failed.length,
    cached: outcome.items.filter(item => item.cached).length,
    usage: usageSummary(outcome.usage), runtime: outcome.runtime,
    category: outcome.error ? classifyDiagnosticError(outcome.error.message, outcome.error.status) : undefined
  });
}

function handleBatchFailure(session, outcome) {
  if (!outcome.error) { session.clearError(); return; }
  const message = outcome.error.message;
  const count = session.recordError(message);
  if (['session-expired', 'no-permission', 'config-changed'].includes(outcome.code)) {
    stop();
    setPhase(PHASE.ERROR, message);
    return;
  }
  if ([401, 403].includes(outcome.error.status) || count >= 3) stop();
  setPhase(PHASE.ERROR, message);
}

async function sendChunk(session, chunk, options = {}) {
  chunk = chunk.filter(unit => session.units.get(unit.id) === unit);
  if (!chunk.length) return;
  if (session !== page || !session.isRunning()) return;
  const attempts = session.beginAttempt(chunk);
  const batch = prepareBatch(session, chunk, options);
  let response;
  try {
    response = await requestSession(session, app.config,
      { type: MSG.TRANSLATE_CHUNK, payload: batch.payload },
      () => recordDiagnostic('session-reconnected', { requestId: batch.requestId }));
  } catch (error) {
    response = { ok: false, error: { message: String(error.message || error), status: 0 } };
  }
  if (session !== page || !session.isRunning()) return;
  const outcome = normalizeBatchOutcome(response, chunk.map(unit => unit.id));
  reportBatch(session, batch, outcome);
  commitBatch(session, chunk, attempts, outcome, batch.observation);
  handleBatchFailure(session, outcome);
}
function runDriftCheck(session = page) {
  if (session !== page || !session.isActive()) return;
  render.clearDriftMarks();
  session.setDrift(detectGlossaryDrift([...session.units.values()], termContract(session)));
  for (const hit of session.drift) {
    const unit = session.units.get(hit.id);
    if (unit?.node) unit.node.dataset.byomDrift = '';
  }
  if (session.drift.length) log('术语不一致：', session.drift);
  if (app.config?.semanticConsistency) {
    const telemetry = consistencySnapshot();
    log('语义一致性观测：', telemetry);
  }
}

/** 清除所有译文并复位，页面回到原样。 */
function clearAll() {
  if (app.running) stop();
  else {
    scheduler?.stop();
    page.invalidate();
  }
  render.removeAll();
  resetIds();
  app.context = null;
  app.pageConfig = null;
  app.preflightSnapshot = null;
  openPageSession({ abortPrevious: false, reason: 'clear-page' });
  setPhase(PHASE.IDLE, t('已清除'));
  return { ok: true, message: t('已清除'), label: t('已清除') };
}

/** 重新翻译 = 新会话重新扫描；bypass 在入队前写入，不留 150ms 的竞态窗口。 */
async function restart({ bypass = false } = {}) {
  const config = app.config;
  if (!config) return { ok: false, message: t('翻译设置尚未就绪，请稍后重试') };
  if (app.running) stop();
  render.removeAll();
  resetIds();
  await start(config, { bypass });
  return { ok: true, message: t('翻译已启动'), label: t('已启动') };
}

/** 给单元标注标题路径。 */
/**
 * 自动预检的 target mappings 与用户规则分权：自动映射不进入 PREFERRED/LOCKED 正式规则块，
 * 只作为单独的 SUGGESTED 提示；用户 hard/preferred 仍保持原权限。
 */
function effectiveProfile(session = page) {
  if (!session.profile && !app.userRules) return null;
  const auto = normalizeRules(session.profile);
  // 防御旧缓存/旧页面状态：自动画像无权通过 principle / hard / keep 改写译文。
  const autoWithoutMappings = { ...auto, principle: '', hard: {}, preferred: {}, keep: [] };
  return mergeRules(autoWithoutMappings, app.userRules);
}

function preflightSuggestions(session = page) {
  return { ...normalizeRules(session.profile).preferred };
}

/** 本页术语契约只检查用户明确锁定的静态规则。预检建议不算违约。 */
function termContract() {
  const user = normalizeRules(app.userRules);
  return { ...user.hard };
}

/**
 * 语义一致性候选池：用户 hard = ENFORCED；预检术语/风险义项 = SUGGESTED；
 * 源文重复观察对象保持各自 lexical/fixed/structural 身份。
 */
function consistencyCandidatePool(session = page) {
  const userLocked = Object.keys(termContract()).map((term) => ({ term, lemma: term.toLowerCase(), kind: 'locked', trust: 'ENFORCED' }));
  const auto = normalizeRules(session.profile);
  const suggestedMap = { ...auto.preferred };
  const suggested = Object.keys(suggestedMap).map((term) => ({ term, lemma: term.toLowerCase(), kind: 'suggested', trust: 'SUGGESTED' }));
  const risky = Object.keys(auto.risky).map((term) => ({ term, lemma: term.toLowerCase(), kind: 'risky', trust: 'SUGGESTED' }));
  return [...userLocked, ...suggested, ...risky, ...repeatedSourceTerms];
}

function preflightRuntimeMeta() {
  const snap = app.preflightSnapshot;
  return snap ? { hash: snap.hash, url: snap.url, reused: Boolean(snap.reused), createdAt: snap.createdAt,
    profile: snap.profile, sourceCoverage: profileSourceCoverage(snap.profile, page.units.values()) } : null;
}

function consistencySnapshot() {
  if (!app.config?.semanticConsistency) return null;
  const snapshot = consistencyTelemetry.snapshot({
    runtime: {
      semanticMemory: { enabled: Boolean(app.config?.semanticPrecedent), ...semanticMemory.stats() },
      preflight: preflightRuntimeMeta(),
      translation: translationStats(),
      usageByPhase: page.usageByPhase
    }
  });
  snapshot.summary.cachedUnitsExcludedFromObservation =
    translationRuntime.cachedUnitsExcludedFromObservation;
  return snapshot;
}

/** MV3 service worker 翻译期间的轻量心跳。 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: MSG.HEARTBEAT, payload: {} }).catch(() => {});
  }, 20000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/* ---------------------------------- 生命周期 ---------------------------------- */

function isBusy() {
  return app.phase === PHASE.TRANSLATING || app.phase === PHASE.SCANNING;
}

function setPhase(phase, message) {
  const previous = app.phase;
  app.phase = phase;
  if (previous !== phase || message) {
    recordDiagnostic('phase', { from: previous, to: phase, hasMessage: Boolean(message) });
  }
  pushStatus(message);
}

function pageStateSnapshot() {
  return {
    running: app.running,
    phase: app.phase,
    total: page.total,
    done: page.done,
    failed: page.failed,
    inflight: scheduler?.inflight || 0,
    visible: render.isVisible(),
    displayMode: render.displayMode(),
    presetId: app.presetId,
    presetReason: app.presetReason,
    background: app.background,
    hasProfile: Boolean(page.profile),
    hasRules: Boolean(app.userRules),
    profileYaml: page.profile ? toYaml(page.profile) : '',
    preflightHash: app.preflightSnapshot?.hash || '',
    preflightReused: Boolean(app.preflightSnapshot?.reused),
    tokens: { ...page.tokens },
    driftCount: page.drift.length,
    consistencyTelemetry: consistencySnapshot(),
    translationRuntime: translationStats(),
    semanticMemory: semanticMemory.stats(),
    message: page.errorMessage
  };

}

function pushStatus(message) {
  const snapshot = { ...pageStateSnapshot(), message: message || page.errorMessage };
  fab.syncPhase();
  hud.update({
    text: message ? t(message) : hudText(snapshot),
    done: snapshot.done,
    total: snapshot.total,
    failed: snapshot.failed,
    phase: snapshot.phase,
    visible: snapshot.visible,
    displayMode: snapshot.displayMode,
    presetId: snapshot.presetId,
    presetReason: snapshot.presetReason
  });

  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: MSG.TAB_STATE, payload: snapshot }).catch(() => {});
  }, 80);
}

function hudText(s) {
  if (s.phase === PHASE.SCANNING) return t('正在扫描页面');
  if (s.phase === PHASE.DONE) {
    const tok = page.tokens.input + page.tokens.output;
    const bits = [t`已完成 · ${s.done} 段`];
    if (translationRuntime.translationMode) {
      bits.push(translationRuntime.translationMode === 'whole-page' ? t('整页模式') : t('分块模式'));
    }
    if (tok) bits.push(`${(tok / 1000).toFixed(1)}k tok`);
    if (page.tokens.cachedUnits) bits.push(t`${page.tokens.cachedUnits} 段走缓存`);
    if (page.drift.length) bits.push(t`⚠ ${page.drift.length} 处术语不一致`);
    return bits.join(' · ');
  }
  if (s.phase === PHASE.PARTIAL) return t`${s.done} 段完成 · ${s.failed} 段失败`;
  if (!s.total) return t('没有找到可翻译的内容');
  return `${s.done} / ${s.total}${s.failed ? t` · ${s.failed} 失败` : ''}`;
}

/** 当前 URL 的派生语境只在 page-context.js 合并一次。 */
function resolveContext() {
  const resolved = resolvePageContext(app.config || {}, app.context || {});
  app.presetId = resolved.presetId;
  app.presetReason = resolved.presetReason;
  app.background = resolved.background;
  app.userRules = resolved.userRules;
  app.pageConfig = resolved.pageConfig;
  return app.pageConfig;
}

/** runtime contract 先分类，再决定重建 session、重扫还是只更新 UI。 */
function applyConfigChange(next) {
  const before = app.config || {};
  if (Number(next.configVersion) < Number(before.configVersion)) return;
  const merged = { ...before, ...next };
  const change = classifyRuntimeConfigChange(before, merged);
  app.config = merged;
  setDebug(app.config.debug);

  render.applyPresentation(app.config);
  syncFab();

  if (!app.running) {
    if (app.context) resolveContext();
    pushStatus();
    return;
  }

  if (change.semantic) {
    log('翻译语义版本变化，建立新页面会话');
    void restart().catch((e) => setPhase(PHASE.ERROR, String(e?.message || e)));
    return;
  }

  if (change.observation.length) {
    log('观测配置变化，建立新页面会话：', change.observation.join(', '));
    void restart().catch((e) => setPhase(PHASE.ERROR, String(e?.message || e)));
    return;
  }

  if (change.scheduling.length) scheduler?.setMaxChars(app.config.maxCharsPerChunk);
  if (change.extraction.length) {
    log('提取配置变了，重新扫描：', change.extraction.join(', '));
    resolveContext();
    rescan();
    return;
  }
  pushStatus();
}

/** 用户在状态条里当场改语境：只影响后续段落。 */
function setPresetManually(presetId) {
  app.presetId = presetId;
  app.presetReason = 'manual';
  log('语境已手动指定：', presetId);
  pushStatus();
}

/** 预检 gate 的 identity 由 PageSession 管理，旧 gate 无权清新 gate。 */
function armPreflightGate() {
  const session = page;
  if (!app.config?.autoPreflight || session.profile || session.gate || !session.isActive()) return;
  setPhase(PHASE.SCANNING, t('正在读取整页语境'));
  const gate = session.beginGate(async () => {
    try {
      return await preflight(session);
    } catch (e) {
      log('预检失败，降级继续翻译：', e?.message || e);
      recordDiagnostic('preflight-exception', {
        name: e?.name || 'Error',
        category: classifyDiagnosticError(e?.message || e, e?.status),
        status: Number(e?.status) || 0
      });
      return null;
    }
  });
  gate.finally(() => {
    if (session !== page || !session.isActive() || !app.running) return;
    setPhase(PHASE.TRANSLATING);
    scheduler?.flush();
  });
}

/** SPA 换路由 = 新页面会话。 */
function refreshContextIfNavigated() {
  if (!app.context) return false;
  if (location.href === app.context.url && document.title === app.context.title) return false;

  openPageSession({ abortPrevious: true, reason: 'navigation' });
  render.removeAll();
  resetIds();
  app.context = collectPageContext();
  resolveContext();
  log('页面已切换，开新会话：', app.presetId, app.context.title);
  armPreflightGate();
  return true;
}

function rescan() {
  if (!app.running) return;
  refreshContextIfNavigated();
  const retired = reconcilePage(page);
  const cfg = app.pageConfig || resolveContext();
  const units = scan(document.body, cfg);
  if (!units.length) { if (retired) pushStatus(); return; }
  page.assignPaths(units);
  refreshRepeatedSourceTerms(units);
  log(`增量发现 ${units.length} 段`);
  enqueue(units);
}

function sourceSnapshot() {
  return scan(document.body, app.pageConfig || app.config || {}, { snapshot: true });
}

function reconcilePage(session) {
  return session.reconcile(sourceSnapshot(), render.detach);
}

async function start(config, { bypass = false } = {}) {
  if (app.running) {
    applyConfigChange(config);
    return;
  }

  app.config = { ...config };
  setDebug(app.config.debug);
  openPageSession({ abortPrevious: false, reason: bypass ? 'restart-bypass-cache' : 'start' });
  page.start();
  page.setBypassCache(Boolean(bypass));
  resetIds();
  render.removeAll();

  render.setDisplayMode(app.config.displayMode || 'bilingual');
  render.applyPresentation(app.config);
  hud.mount({
    stop: onHudStop,
    toggle: () => cycleDisplayMode({ waitForSave: true }),
    clear: clearAll,
    bypass: () => restart({ bypass: true }),
    preset: setPresetManually,
    presetOptions: presetOptions(),
    translateUi: t
  });
  setPhase(PHASE.SCANNING);

  app.context = collectPageContext();
  resolveContext();
  syncFab();
  recordDiagnostic('translation-started', {
    bypassCache: Boolean(bypass),
    engineKind: app.config?.engineKind || 'unknown',
    targetLang: app.config?.targetLang || '',
    presetId: app.presetId,
    presetReason: app.presetReason,
    autoPreflight: Boolean(app.config?.autoPreflight),
    wholePageTranslation: Boolean(app.config?.wholePageTranslation)
  });
  log('页面语境', app.presetId, app.presetReason, app.context.hostname);

  mutationWatcher?.stop();
  mutationWatcher = createMutationWatcher(rescan);

  const units = scan(document.body, app.pageConfig);
  page.assignPaths(units);
  refreshRepeatedSourceTerms(units);
  enqueue(units);

  mutationWatcher.start();
  armPreflightGate();

  if (!units.length) setPhase(PHASE.DONE);
}

function stop({ keepHud = true } = {}) {
  if (!app.running) return;
  const session = page;
  recordDiagnostic('translation-stopped', {
    phase: app.phase,
    done: session.done,
    failed: session.failed,
    keepHud: Boolean(keepHud)
  });
  chrome.runtime
    .sendMessage({ type: MSG.ABORT_SESSION, payload: { sessionId: session.id } })
    .catch(() => {});
  scheduler?.stop();
  session.invalidate();
  stopHeartbeat();
  mutationWatcher?.stop();

  for (const unit of session.units.values()) {
    if (unit.state === 'pending' || unit.state === 'queued') render.detach(unit);
  }
  setPhase(session.done ? PHASE.PARTIAL : PHASE.IDLE, t('已停止'));
  if (!keepHud) hud.unmount();
}

function onHudStop() {
  if (app.running && isBusy()) {
    stop();
    return { ok: true, message: t('已停止'), label: t('已停止') };
  }
  return restart();
}

const MODE_LABEL = { bilingual: '双语', translation: '仅译文', original: '仅原文' };

/**
 * 页面上切换显示模式 = 改设置，不是改这一页的 DOM。
 * 否则切一次只对当前页生效，下一页打开又回到默认 —— 那不是偏好该有的行为。
 */
function cycleDisplayMode({ waitForSave = false } = {}) {
  const mode = render.cycleDisplay();
  if (app.config) app.config.displayMode = mode;
  const saving = runtimeReply({ type: MSG.SAVE_DISPLAY_MODE, payload: { mode } });
  const result = saving.then(response => {
    if (!response?.ok) throw new Error(response?.error?.message || t('显示已切换，但偏好未保存，请重试'));
    return { ok: true, message: t`显示：${MODE_LABEL[mode]}` };
  }).catch(error => {
    if (!waitForSave) fab.flash(t('显示已切换，但偏好未保存，请重试'));
    return { ok: false, message: error.message };
  });
  pushStatus(t`显示：${MODE_LABEL[mode]}`);
  return waitForSave ? result : mode;
}

/** 双击某条译文 = 只重翻这一段，并绕过缓存 */
document.addEventListener(
  'dblclick',
  (e) => {
    const id = render.findUnitIdFromEvent(e);
    if (!id) return;
    const unit = page.units.get(id);
    if (!unit || !app.running) return;
    if (!page.prepareRetry(unit)) return;
    e.preventDefault();
    // 双击本来就是"这段翻得不对"，正好是最该拿去试译的样本
    chrome.runtime
      .sendMessage({ type: MSG.SET_LAB_SAMPLE, payload: { text: unit.text } })
      .catch(() => {});
    render.attach(unit);
    scheduler?.sendNow([unit], { bypassCache: true });
  },
  true
);

/** Reuse only a matching language, content and effective-rule snapshot. */
function preparePreflight(session) {
  if (!app.context) app.context = collectPageContext();
  if (!app.presetId || app.presetId === 'general') resolveContext();
  const config = app.pageConfig || app.config || {};
  const units = scan(document.body, { ...config, minTextLength: config.minTextLength ?? 2 }, { snapshot: true });
  const url = location.href;
  const identity = hashString(JSON.stringify({
    url, title: document.title, target: config.targetLang, rules: app.userRules,
    background: app.background, preset: app.presetId, prompt: PROMPT_VERSION, revision: config.semanticRevision,
    sources: units.map(unit => unit.text)
  }));
  return { url, identity, digest: buildPlainDigest(units), units, context: app.context };
}

function reusePreflight(session) {
  const cached = app.preflightSnapshot;
  cached.reused = true;
  session.setProfile(cached.profile);
  recordDiagnostic('preflight-reused', { hash: cached.hash, ...profileSummary(cached.profile) });
  pushStatus(t('已复用本页语境快照'));
  return { ok: true, profile: cached.profile, profileYaml: toYaml(cached.profile), profileHash: cached.hash, reused: true };
}

function acceptPreflight(session, prepared, request, response) {
  if (session !== page || prepared.url !== location.href) {
    return { ok: false, code: 'stale', error: { message: t('预检结果已过期') } };
  }
  session.addUsage(response.usage, 'preflight', response.usageIncomplete ?? !response.ok);
  if (!request.isCurrent()) {
    recordDiagnostic('preflight-discarded', { reason: 'superseded-or-stopped', usage: usageSummary(response.usage),
      runtime: response.runtime, usageIncomplete: response.usageIncomplete });
    return { ok: false, code: 'stale', error: { message: t('预检结果已过期') } };
  }
  if (prepared.identity !== preparePreflight(session).identity) {
    recordDiagnostic('preflight-discarded', { reason: 'content-changed', usage: usageSummary(response.usage),
      runtime: response.runtime, usageIncomplete: response.usageIncomplete });
    return { ok: false, code: 'content-changed' };
  }
  if (!response.ok) {
    const error = response.error || {};
    recordDiagnostic('preflight-error', {
      code: response.code || 'unknown', status: Number(error.status) || 0,
      category: classifyDiagnosticError(error.message || t('请求失败'), error.status),
      usage: usageSummary(response.usage), runtime: response.runtime, usageIncomplete: response.usageIncomplete
    });
    return response;
  }
  const profile = softenAutoRules(response.profile);
  const hash = hashString(JSON.stringify(profile));
  const { url, identity, digest } = prepared;
  const reused = Boolean(response.reused);
  app.preflightSnapshot = { url, identity, profile, hash, createdAt: Date.now(), reused };
  session.setProfile(profile);
  recordDiagnostic('preflight-result', {
    hash, reused, cacheSource: response.cacheSource || 'fresh', digestChars: digest.chars, sampled: Boolean(digest.sampled),
    usage: usageSummary(response.usage), runtime: response.runtime,
    usageIncomplete: response.usageIncomplete, ...profileSummary(profile)
  });
  pushStatus(t('页面语境已读取；自动术语只作为建议'));
  return {
    ok: true, profile, profileYaml: toYaml(profile), profileHash: hash,
    reused, digestChars: digest.chars, sampled: digest.sampled, usage: response.usage
  };
}

async function preflight(session = page, { force = false, refreshAttempted = false } = {}) {
  const prepared = preparePreflight(session);
  const { identity, digest, units, context } = prepared;
  if (!force && app.preflightSnapshot?.identity === identity) return reusePreflight(session);
  if (!digest.text) {
    recordDiagnostic('preflight-skipped', { reason: 'empty-digest', units: units.length });
    return { ok: false, error: { message: t('页面没有可分析的正文') } };
  }
  const request = session.beginPreflight();
  recordDiagnostic('preflight-request', {
    force: Boolean(force), units: units.length, digestChars: digest.chars, sampled: Boolean(digest.sampled)
  });
  let response;
  try {
    response = await requestSession(session, app.config, {
      type: MSG.PREFLIGHT,
      payload: { sessionId: session.id, digest: digest.text, identity, force,
        context: { title: context.title, hostname: context.hostname } }
    }, () => recordDiagnostic('session-reconnected', { stage: 'preflight' }));
  } catch (error) {
    response = { ok: false, error: { message: String(error.message || error) } };
  }
  const result = acceptPreflight(session, prepared, request, response || { ok: false });
  if (result.code === 'content-changed') {
    rescan();
    if (!refreshAttempted) return preflight(session, { force: true, refreshAttempted: true });
  }
  return result;
}

function digestInfo() {
  const config = app.pageConfig || app.config || {};
  const units = page.units.size
    ? [...page.units.values()]
    : scan(document.body, { ...config, minTextLength: config.minTextLength ?? 2 });
  const d = buildPlainDigest(units);
  return { ok: true, chars: d.chars, sampled: d.sampled, estTokens: Math.round(d.chars / 3.5) };
}

/**
 * running 同时表示"session 活着"和"正在忙"是错的：翻完之后 observer 还在工作，
 * running 仍是 true，此时点球会直接把 session 停掉。按 phase 判断才对。
 */
async function fabTranslate() {
  if (isBusy()) { stop(); return { ok: true, message: t('已停止'), label: t('已停止') }; }
  if (page.done || page.failed) return restart();
  const res = await runtimeReply({ type: MSG.START_ON_TAB, payload: {} })
    .catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
  return res?.ok ? { ok: true, message: t('翻译已启动'), label: t('已启动') }
    : { ok: false, message: res?.error?.message || t('启动失败') };
}

async function fabPreflight() {
  const res = await waitForReply(preflight(page, { force: true }), 360000);
  return res?.ok ? { ok: true, message: t('页面语境已更新') }
    : { ok: false, message: res?.error?.message || t('读取页面语境失败') };
}

/**
 * 悬浮球同步。幂等，配置来自哪条路径都一样调 ——
 * 之前 START / CONFIG_CHANGED / bootstrap 三条路径时序不同，
 * 某些进入方式下 config 还是 null，球就不出现。
 */
function syncFab(nextConfig = app.config || {}) {
  fab.sync(nextConfig, {
    translate: fabTranslate,
    preflight: fabPreflight,
    clear: clearAll,
    moved: (offset) => {
      if (app.config) app.config.floatOffset = offset;
      void runtimeReply({ type: MSG.SAVE_FAB_OFFSET, payload: { offset } })
        .then(result => { if (!result?.ok) fab.flash(t('位置未能保存，请重试')); })
        .catch(() => fab.flash(t('位置未能保存，请重试')));
    },
    state: () => ({ running: app.running, phase: app.phase, done: page.done, failed: page.failed })
  });
}

/* ---------------------------------- 消息接口 ---------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case MSG.PING:
      sendResponse({ ok: true });
      return false;
    case MSG.GET_STATE:
      sendResponse({ ok: true, ...pageStateSnapshot() });
      return false;
    case MSG.START:
      start(msg.payload.config).catch((e) => setPhase(PHASE.ERROR, String(e.message || e)));
      sendResponse({ ok: true });
      return false;
    case MSG.STOP:
      stop();
      sendResponse({ ok: true });
      return false;
    case MSG.TOGGLE_VISIBILITY:
      sendResponse({ ok: true, mode: cycleDisplayMode(), visible: render.isVisible() });
      return false;
    case MSG.RESET_PROFILE:
      page.clearProfile();
      app.preflightSnapshot = null;
      scheduler?.resetFirstBatch();
      recordDiagnostic('preflight-reset', {});
      armPreflightGate();
      pushStatus(t('本页语境已复位'));
      sendResponse({ ok: true });
      return false;
    case MSG.CLEAR_PAGE:
      clearAll();
      sendResponse({ ok: true });
      return false;
    case MSG.RESTART_PAGE:
      restart({ bypass: Boolean(msg.payload?.bypass) });
      sendResponse({ ok: true });
      return false;
    case MSG.RUN_PREFLIGHT:
      preflight(page, { force: true }).then(sendResponse);
      return true;
    case MSG.DIGEST_INFO:
      sendResponse(digestInfo());
      return false;
    case MSG.EXPORT_MD:
      sendResponse({ ok: true, markdown: buildBilingualMarkdown([...page.units.values()]) });
      return false;
    case MSG.GET_DIAGNOSTICS:
      sendResponse({ ok: true, diagnostic: exportDiagnostics(msg.payload) });
      return false;
    case MSG.CLEAR_DIAGNOSTICS:
      sendResponse({ ok: clearDiagnosticLog(msg.payload) });
      return false;
    case MSG.CONFIG_CHANGED:
      applyConfigChange(msg.payload.config);
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

/**
 * 自举：脚本由 manifest 静态拉起时没人主动推配置，所以页面自己取一次 RuntimeConfig。
 * 主动要一次，悬浮球、译文样式、以及"本站自动翻译"才可能生效。
 */
async function bootstrap() {
  // 悬浮球是页面侧 UI，不应该把“能不能出现”绑在 MV3 service worker 的冷启动上。
  // 先用随扩展打包的默认值立即挂载；后台真配置回来后再幂等校正。
  // 用户若关过悬浮球，极慢冷启动时最多短暂看到默认球，随后会被真实配置移除。
  syncFab({ ...DEFAULT_SETTINGS, targetLang: browserUserLanguage() });

  const res = await chrome.runtime.sendMessage({ type: MSG.GET_CONFIG, payload: {} }).catch(() => null);
  if (res?.ok) {
    if (Number(res.config.configVersion) < Number(app.config?.configVersion)) return;
    app.config = { ...app.config, ...res.config };
    setDebug(app.config.debug);
    render.applyPresentation(app.config);
    syncFab();

    // 站点规则里勾了"打开就翻"的，直接开跑，不用再点任何东西
    const host = location.hostname.toLowerCase();
    const rule = (app.config.siteRules || []).find(
      (r) => r?.auto && r.host && (host === r.host.toLowerCase() || host.endsWith('.' + r.host.toLowerCase()))
    );
    if (rule && !app.running) {
      log('本站规则为自动翻译，开始');
      // 不带 tabId：后台会从 sender.tab.id 取，保证翻的是这一页
      chrome.runtime.sendMessage({ type: MSG.START_ON_TAB, payload: {} }).catch(() => {});
    }
  }
}

bootstrap();
log('content 就绪');
