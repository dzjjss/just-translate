import { DEFAULT_SETTINGS, MSG, PHASE } from '../shared/constants.js';
import { setDebug, log } from '../shared/logger.js';
import { presetOptions } from '../prompt/presets.js';
import { collectPageContext, resetIds, scan } from './extractor.js';
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
import { createTermTelemetry, extractRepeatedSourceTerms, matchTrackedTermRows } from './term-consistency.js';
import { createSemanticMemory } from './semantic-memory.js';
import { hashString } from '../shared/hash.js';
import { buildMachineContext } from './machine-context.js';

/**
 * 页面侧控制器。它拥有 DOM 与调度，但完全不知道 API Key、供应商、prompt 长什么样。
 * 与后台的契约只有一条消息：TRANSLATE_CHUNK。
 */

const app = {
  running: false,
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

let page = createPageSession();
let scheduler = null;
let mutationWatcher = null;
let statusTimer = null;
let heartbeatTimer = null;
let repeatedSourceTerms = [];
let consistencyTelemetry = createTermTelemetry();
let semanticMemory = createSemanticMemory();
let translationRuntime = createTranslationRuntime();

function createTranslationRuntime() {
  return {
    translationMode: null,
    modeReason: null,
    sourceChars: 0,
    unitCount: 0,
    translateRequestCount: 0,
    splitRetryCount: 0,
    wholePageCacheHit: false,
    boundaryRecoveryCount: 0,
    machineContextChars: 0
  };
}

function makeScheduler(session) {
  return createTranslationScheduler({
    session,
    maxChars: app.config?.maxCharsPerChunk,
    wholePage: app.config?.wholePageTranslation,
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
function openPageSession({ abortPrevious = true } = {}) {
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
  repeatedSourceTerms = [];
  consistencyTelemetry = createTermTelemetry();
  semanticMemory = createSemanticMemory();
  translationRuntime = createTranslationRuntime();
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
  scheduler?.enqueue(accepted);
  pushStatus();
}

function refreshRepeatedSourceTerms(extraUnits = []) {
  // 这张源词表同时服务一致性 telemetry 与可选的 session precedent memory。
  // 只看源文，纯本地统计；关闭观测与 precedent 时也不会额外请求模型。
  const all = [...page.units.values(), ...(extraUnits || [])];
  repeatedSourceTerms = extractRepeatedSourceTerms(all);
  log('跨 chunk 源词候选：', repeatedSourceTerms.map((x) => `${x.term}×${x.units}`).slice(0, 24));
}

async function sendChunk(
  session,
  chunk,
  { bypassCache = false, wholePage = false, modeReason = null, sourceChars = 0, unitCount = 0 } = {}
) {
  if (!session.isActive() || session !== page || !app.running) return;

  if (modeReason && !translationRuntime.translationMode) {
    translationRuntime.translationMode = wholePage ? 'whole-page' : 'chunked';
    translationRuntime.modeReason = modeReason;
    translationRuntime.sourceChars = Number(sourceChars) || 0;
    translationRuntime.unitCount = Number(unitCount) || 0;
  }

  // Precedent 的 alignment 只跟踪当前批真正命中的重复 lexical term；纯观测开启时，
  // 再把 locked/fixed 观测对象并进来。两者共用一个可选 a 字段，不增加第二次请求。
  const memoryRows = app.config?.semanticPrecedent
    ? matchTrackedTermRows(
        repeatedSourceTerms.filter((row) => row.kind === 'lexical'),
        chunk,
        { maxTerms: 8 }
      )
    : [];
  const consistencyRows = app.config?.semanticConsistency
    ? matchTrackedTermRows(consistencyCandidatePool(session), chunk, { maxTerms: 16 })
    : [];
  const byLemma = new Map();
  for (const row of [...consistencyRows, ...memoryRows]) {
    const key = String(row?.lemma || row?.term || '').toLowerCase();
    if (key && !byLemma.has(key)) byLemma.set(key, row);
  }
  const trackedRows = [...byLemma.values()].slice(0, 16);
  const trackedTerms = trackedRows.map((row) => row.term);
  const memoryHints = app.config?.semanticPrecedent ? semanticMemory.hintsFor(chunk, memoryRows) : [];

  // 请求发出前做一次快照，后续页面配置/语境改变也不会让这一批半路换语义。
  const context = {
    ...app.context,
    presetId: app.presetId,
    background: app.background,
    profile: effectiveProfile(session),
    preflightSuggestions: preflightSuggestions(session),
    trackedTerms,
    semanticMemory: memoryHints,
    sectionPath: chunk[0]?.path || '',
    wholePage: Boolean(wholePage),
    mtContext: app.config?.engineKind === 'mt' && !wholePage
      ? buildMachineContext({
          units: [...session.units.values()],
          chunk,
          title: app.context?.title || '',
          sectionPath: chunk[0]?.path || ''
        })
      : ''
  };
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.TRANSLATE_CHUNK,
      payload: {
        sessionId: session.id,
        bypassCache: bypassCache || session.bypassCache,
        items: chunk.map((u) => ({ i: u.id, text: u.text })),
        context
      }
    });

    if (!session.isActive() || session !== page || !app.running) return;

    if (!res?.ok) {
      const msg = res?.error?.message || '请求失败';
      for (const unit of chunk) {
        if (!render.fail(unit, msg)) continue;
        unit.state = 'error';
        session.markFailed();
      }
      if (res?.code !== 'aborted') {
        if (session.recordError(msg) >= 3) {
          stop();
          setPhase(PHASE.ERROR, `已停止：连续出错（${msg}）`);
          return;
        }
        setPhase(PHASE.ERROR, msg);
      }
      return;
    }

    session.clearError();
    session.addUsage(res.usage);
    session.addCachedItems(res.items);
    translationRuntime.translateRequestCount += Number(res.runtime?.translateRequestCount) || 0;
    translationRuntime.splitRetryCount += Number(res.runtime?.splitRetryCount) || 0;
    translationRuntime.wholePageCacheHit =
      translationRuntime.wholePageCacheHit || Boolean(res.runtime?.wholePageCacheHit);
    translationRuntime.boundaryRecoveryCount += Number(res.runtime?.boundaryRecoveryCount) || 0;
    translationRuntime.machineContextChars += Number(res.runtime?.machineContextChars) || 0;

    const failedIds = new Set(res.failed || []);
    const byId = new Map((res.items || []).map((it) => [it.i, it]));

    for (const unit of chunk) {
      const item = byId.get(unit.id);
      const t = item?.t;
      if (app.config?.semanticPrecedent && typeof t === 'string' && memoryRows.length) {
        semanticMemory.recordHintOutcomes({
          unit,
          translation: t,
          alignments: item?.a || null,
          hints: memoryHints
        });
        semanticMemory.observe({
          unit,
          translation: t,
          alignments: item?.a || null,
          candidates: memoryRows
        });
      }
      if (
        app.config?.semanticConsistency &&
        typeof t === 'string' &&
        consistencyRows.length
      ) {
        consistencyTelemetry.record({
          unit,
          translation: t,
          alignments: item?.a || null,
          candidates: consistencyRows
        });
      }
      if (typeof t === 'string' && !failedIds.has(unit.id)) {
        if (!render.fill(unit, t)) continue;
        unit.state = 'done';
        session.markDone();
      } else {
        if (!render.fail(unit, '模型没有返回这一段')) continue;
        unit.state = 'error';
        session.markFailed();
      }
    }
  } catch (e) {
    if (!session.isActive() || session !== page || !app.running) return;
    for (const unit of chunk) {
      if (!render.fail(unit, String(e.message || e))) continue;
      unit.state = 'error';
      session.markFailed();
    }
  }
}

/** 译后一致性检查。契约只来自预检画像 + 用户规则，违约只标记不自动改。 */
function runDriftCheck(session = page) {
  if (session !== page || !session.isActive()) return;
  document.querySelectorAll('.byom-t[data-byom-drift]').forEach((n) => delete n.dataset.byomDrift);
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
  openPageSession({ abortPrevious: false });
  setPhase(PHASE.IDLE, '已清除');
}

/** 重新翻译 = 新会话重新扫描；bypass 在入队前写入，不留 150ms 的竞态窗口。 */
async function restart({ bypass = false } = {}) {
  const config = app.config;
  if (!config) return;
  if (app.running) stop();
  render.removeAll();
  resetIds();
  await start(config, { bypass });
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
 * 语义一致性候选池：用户 hard = ENFORCED；预检术语 = SUGGESTED；
 * 源文重复观察对象保持各自 lexical/fixed/structural 身份。
 */
function consistencyCandidatePool(session = page) {
  const userLocked = Object.keys(termContract()).map((term) => ({ term, lemma: term.toLowerCase(), kind: 'locked', trust: 'ENFORCED' }));
  const auto = normalizeRules(session.profile);
  const suggestedMap = { ...auto.preferred };
  const suggested = Object.keys(suggestedMap).map((term) => ({ term, lemma: term.toLowerCase(), kind: 'suggested', trust: 'SUGGESTED' }));
  return [...userLocked, ...suggested, ...repeatedSourceTerms];
}

function preflightRuntimeMeta() {
  const snap = app.preflightSnapshot;
  return snap ? { hash: snap.hash, url: snap.url, reused: Boolean(snap.reused), createdAt: snap.createdAt, profile: snap.profile } : null;
}

function consistencySnapshot() {
  if (!app.config?.semanticConsistency) return null;
  return consistencyTelemetry.snapshot({
    runtime: {
      semanticMemory: { enabled: Boolean(app.config?.semanticPrecedent), ...semanticMemory.stats() },
      preflight: preflightRuntimeMeta(),
      translation: { ...translationRuntime, tokens: { ...page.tokens } }
    }
  });
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
  app.phase = phase;
  pushStatus(message);
}

function pushStatus(message) {
  const snapshot = {
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
    translationRuntime: { ...translationRuntime },
    semanticMemory: semanticMemory.stats(),
    message: message || ''
  };

  fab.syncPhase();
  hud.update({
    text: message || hudText(snapshot),
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
  if (s.phase === PHASE.SCANNING) return '正在扫描页面';
  if (s.phase === PHASE.DONE) {
    const tok = page.tokens.input + page.tokens.output;
    const bits = [`已完成 · ${s.done} 段`];
    if (translationRuntime.translationMode) {
      bits.push(translationRuntime.translationMode === 'whole-page' ? '整页模式' : '分块模式');
    }
    if (tok) bits.push(`${(tok / 1000).toFixed(1)}k tok`);
    if (page.tokens.cachedUnits) bits.push(`${page.tokens.cachedUnits} 段走缓存`);
    if (page.drift.length) bits.push(`⚠ ${page.drift.length} 处术语不一致`);
    return bits.join(' · ');
  }
  if (s.phase === PHASE.PARTIAL) return `${s.done} 段完成 · ${s.failed} 段失败`;
  if (!s.total) return '没有找到可翻译的内容';
  return `${s.done} / ${s.total}${s.failed ? ` · ${s.failed} 失败` : ''}`;
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
  const merged = { ...before, ...next };
  const change = classifyRuntimeConfigChange(before, merged);
  app.config = merged;
  setDebug(app.config.debug);

  render.applyPresentation(app.config);
  syncFab();

  if (!app.running) {
    if (app.context) resolveContext();
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
  setPhase(PHASE.SCANNING, '正在读取整页语境');
  const gate = session.beginGate(async () => {
    try {
      return await preflight(session);
    } catch (e) {
      log('预检失败，降级继续翻译：', e?.message || e);
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

  openPageSession({ abortPrevious: true });
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
  const cfg = app.pageConfig || resolveContext();
  const units = scan(document.body, cfg);
  if (!units.length) return;
  page.assignPaths(units);
  refreshRepeatedSourceTerms(units);
  log(`增量发现 ${units.length} 段`);
  enqueue(units);
}

async function start(config, { bypass = false } = {}) {
  if (app.running) {
    applyConfigChange(config);
    return;
  }

  app.config = { ...config };
  setDebug(app.config.debug);
  app.running = true;
  openPageSession({ abortPrevious: false });
  page.setBypassCache(Boolean(bypass));
  resetIds();

  render.setDisplayMode(app.config.displayMode || 'bilingual');
  render.applyPresentation(app.config);
  hud.mount({
    stop: onHudStop,
    toggle: cycleDisplayMode,
    clear: clearAll,
    bypass: () => restart({ bypass: true }),
    preset: setPresetManually,
    presetOptions: presetOptions()
  });
  setPhase(PHASE.SCANNING);

  app.context = collectPageContext();
  resolveContext();
  syncFab();
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
  chrome.runtime
    .sendMessage({ type: MSG.ABORT_SESSION, payload: { sessionId: session.id } })
    .catch(() => {});
  app.running = false;
  scheduler?.stop();
  session.invalidate();
  stopHeartbeat();
  mutationWatcher?.stop();

  for (const unit of session.units.values()) {
    if (unit.state === 'pending' || unit.state === 'queued') render.detach(unit);
  }
  setPhase(session.done ? PHASE.PARTIAL : PHASE.IDLE, '已停止');
  if (!keepHud) hud.unmount();
}

function onHudStop() {
  if (app.running && isBusy()) stop();
  else restart();
}

const MODE_LABEL = { bilingual: '双语', translation: '仅译文', original: '仅原文' };

/**
 * 页面上切换显示模式 = 改设置，不是改这一页的 DOM。
 * 否则切一次只对当前页生效，下一页打开又回到默认 —— 那不是偏好该有的行为。
 */
function cycleDisplayMode() {
  const mode = render.cycleDisplay();
  if (app.config) app.config.displayMode = mode;
  chrome.runtime
    .sendMessage({ type: MSG.SAVE_DISPLAY_MODE, payload: { mode } })
    .catch(() => {});
  pushStatus(`显示：${MODE_LABEL[mode]}`);
  return mode;
}

/** 双击某条译文 = 只重翻这一段，并绕过缓存 */
document.addEventListener(
  'dblclick',
  (e) => {
    const id = render.findUnitIdFromEvent(e.target);
    if (!id) return;
    const unit = page.units.get(id);
    if (!unit || !app.running) return;
    e.preventDefault();
    // 双击本来就是"这段翻得不对"，正好是最该拿去试译的样本
    chrome.runtime
      .sendMessage({ type: MSG.SET_LAB_SAMPLE, payload: { text: unit.text } })
      .catch(() => {});
    if (unit.state === 'done') page.markDone(-1);
    if (unit.state === 'error') page.markFailed(-1);
    unit.state = 'queued';
    render.attach(unit);
    scheduler?.sendNow([unit], { bypassCache: true });
  },
  true
);

/**
 * 翻译预检。普通重翻默认复用同一 URL 已生成的 snapshot，保证 A/B 时规则集不漂；
 * 用户显式点“重新读取”才 force 生成新画像。
 */
async function preflight(session = page, { force = false } = {}) {
  const url = location.href;
  if (!force && app.preflightSnapshot?.url === url) {
    const cached = app.preflightSnapshot;
    cached.reused = true;
    session.setProfile(cached.profile);
    pushStatus('已复用本页语境快照');
    return { ok: true, profile: cached.profile, profileYaml: toYaml(cached.profile), profileHash: cached.hash, reused: true };
  }

  const request = session.beginPreflight();
  const context = app.context || collectPageContext();
  if (!app.context) app.context = context;
  if (!app.presetId || app.presetId === 'general') resolveContext();

  const config = app.pageConfig || app.config || {};
  const units = session.units.size
    ? [...session.units.values()]
    : scan(document.body, { ...config, minTextLength: config.minTextLength ?? 2 });
  const digest = buildPlainDigest(units);
  if (!digest.text) return { ok: false, error: { message: '页面没有可分析的正文' } };

  const res = await chrome.runtime.sendMessage({
    type: MSG.PREFLIGHT,
    payload: {
      sessionId: session.id,
      digest: digest.text,
      context: { title: context.title, hostname: context.hostname }
    }
  });
  if (!res?.ok) return res;
  if (session !== page || url !== location.href || !request.isCurrent()) {
    log('预检回来时页面或请求代次已变化，丢弃这份画像');
    return { ok: false, code: 'stale', error: { message: '预检结果已过期' } };
  }

  const profile = softenAutoRules(res.profile);
  const hash = hashString(JSON.stringify(profile));
  app.preflightSnapshot = { url, profile, hash, createdAt: Date.now(), reused: false };
  session.setProfile(profile);
  session.addUsage(res.usage);
  pushStatus('页面语境已读取；自动术语只作为建议');
  return {
    ok: true,
    profile,
    profileYaml: toYaml(profile),
    profileHash: hash,
    reused: false,
    digestChars: digest.chars,
    sampled: digest.sampled,
    usage: res.usage
  };
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
  if (isBusy()) return stop();
  if (page.done || page.failed) return restart();
  const res = await chrome.runtime
    .sendMessage({ type: MSG.START_ON_TAB, payload: {} })
    .catch((e) => ({ ok: false, error: { message: String(e?.message || e) } }));
  if (!res?.ok) fab.flash(res?.error?.message || '启动失败');
}

async function fabPreflight() {
  const res = await preflight(page, { force: true });
  if (!res?.ok) fab.flash(res?.error?.message || '读取页面语境失败');
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
      chrome.runtime.sendMessage({ type: MSG.SAVE_FAB_OFFSET, payload: { offset } }).catch(() => {});
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
      sendResponse({
        ok: true,
        running: app.running,
        phase: app.phase,
        total: page.total,
        done: page.done,
        failed: page.failed,
        visible: render.isVisible(),
        displayMode: render.displayMode(),
        presetId: app.presetId,
        presetReason: app.presetReason,
        background: app.background,
        hasProfile: Boolean(page.profile),
        hasRules: Boolean(app.userRules),
        // 画像直接以 YAML 交出去：它和用户规则本来就是同一个六键结构，
        // 没理由让人只能看到"锁定 5 词"这种看不出判成了什么的摘要
        profileYaml: page.profile ? toYaml(page.profile) : '',
        preflightHash: app.preflightSnapshot?.hash || '',
        preflightReused: Boolean(app.preflightSnapshot?.reused),
        tokens: page.tokens,
        driftCount: page.drift.length,
        consistencyTelemetry: consistencySnapshot(),
        translationRuntime: { ...translationRuntime }
      });
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
      armPreflightGate();
      pushStatus('本页语境已复位');
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
  syncFab(DEFAULT_SETTINGS);

  const res = await chrome.runtime.sendMessage({ type: MSG.GET_CONFIG, payload: {} }).catch(() => null);
  if (res?.ok) {
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
