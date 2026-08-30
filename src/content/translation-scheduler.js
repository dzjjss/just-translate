import { LIMITS, PHASE } from '../shared/constants.js';
import { buildChunks } from './chunker.js';

/**
 * 一页一个调度器。pending / inflight / firstBatchDone / drain 锁全部归它所有，DOM、
 * profile 等页面语义不归它。这样“第一批必须先完成”“同会话只有一个 drain”这些
 * 时序规则只存在一份，不再散落在 main.js 的几个回调里。
 */
export function createTranslationScheduler({
  session,
  maxChars = 2800,
  wholePage = false,
  send,
  priority = null,
  onPhase = () => {},
  onStatus = () => {},
  onIdle = () => {},
  onWork = () => {},
  log = () => {}
}) {
  let pending = [];
  let inflight = 0;
  let firstBatchDone = false;
  let drainPromise = null;
  let timer = null;
  let active = true;
  let chunkChars = maxChars;
  const preferWholePage = Boolean(wholePage);
  let modePlan = null;

  const alive = () => active && session.isActive();

  /**
   * 从待翻队列取下一批。priority(unit) 为真的段（通常是"在视口附近"）
   * 整体优先，组内保持文档顺序。优先级在取批瞬间现算——用户翻页了，
   * 下一批取到的就是新视口的内容。这里没有登记、没有生命周期，
   * 只有一次读取加一次分组。
   */
  function takeChunk() {
    if (!pending.length) return [];

    // 首轮 gate 放行时对完整扫描快照做一次确定性判断。决策在会话内锁定：
    // 后来出现的动态节点不能冒充“全文”，因此只继续沿用分块调度。
    if (!modePlan) modePlan = decideTranslationMode(pending, { preferWholePage });
    if (modePlan.translationMode === 'whole-page' && !firstBatchDone) {
      const chunk = pending;
      pending = [];
      return chunk;
    }

    let pool = pending;
    if (priority) {
      const near = pending.filter((u) => priority(u));
      if (near.length && near.length < pending.length) pool = near;
    }
    const chunk =
      buildChunks(pool, { maxChars: chunkChars, maxItems: LIMITS.MAX_ITEMS_PER_CHUNK })[0] || [];
    if (chunk.length) {
      const taken = new Set(chunk);
      pending = pending.filter((u) => !taken.has(u));
    }
    return chunk;
  }

  function schedule(delay = 150) {
    if (!alive()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {});
    }, delay);
  }

  function enqueue(units) {
    if (!alive() || !units?.length) return;
    pending.push(...units);
    onWork();
    schedule();
    onStatus();
  }

  async function runChunk(chunk, options = {}) {
    if (!alive() || !chunk?.length) return;
    inflight++;
    onStatus();
    try {
      await send(session, chunk, options);
    } finally {
      inflight = Math.max(0, inflight - 1);
      onStatus();
    }
  }

  /** 工作池逐批拉取，直到队列空。每个 await 后都再检查 session 是否还活着。 */
  async function worker() {
    while (alive()) {
      const chunk = takeChunk();
      if (!chunk.length) return;
      await runChunk(chunk, schedulerOptions());
    }
  }

  async function drain() {
    if (!alive() || !pending.length) return;

    if (!(await session.waitForGate()) || !alive()) return;

    log(`开始翻译，待翻 ${pending.length} 段`);
    onPhase(PHASE.TRANSLATING);

    // 第一批必须真正返回后才允许并发。旧 drain 绝不能在换页后把
    // firstBatchDone 写到新页，或继续把旧 chunks 发出去。
    if (!firstBatchDone) {
      const first = takeChunk();
      if (!first.length) return;
      await runChunk(first, schedulerOptions());
      if (!alive()) return;
      firstBatchDone = true;
    }

    // 之后按固定宽度并发。整页在这里排队而不是一次全发出去，
    // 视口优先才有意义：每空出一个位子，取的都是此刻离用户最近的一批。
    const width = Math.min(LIMITS.MAX_CONCURRENT_CHUNKS, Math.max(pending.length, 1));
    await Promise.all(Array.from({ length: width }, () => worker()));
    if (!alive()) return;

    if (!pending.length && inflight === 0) onIdle();
  }

  function flush() {
    if (!alive() || !pending.length) return Promise.resolve();
    if (drainPromise) return drainPromise;
    let current;
    current = drain().finally(() => {
      if (drainPromise === current) drainPromise = null;
      if (alive() && pending.length) schedule(0);
    });
    drainPromise = current;
    return current;
  }

  function stop() {
    active = false;
    pending = [];
    clearTimeout(timer);
    timer = null;
  }

  return {
    enqueue,
    flush,
    stop,
    sendNow: runChunk,
    setMaxChars(value) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) chunkChars = n;
    },
    resetFirstBatch() {
      firstBatchDone = false;
      modePlan = null;
    },
    get pendingCount() {
      return pending.length;
    },
    get inflight() {
      return inflight;
    },
    get firstBatchDone() {
      return firstBatchDone;
    },
    get wholePage() {
      return modePlan?.translationMode === 'whole-page';
    },
    get modePlan() {
      return modePlan ? { ...modePlan } : null;
    }
  };

  function schedulerOptions() {
    if (!modePlan) return {};
    return {
      wholePage: modePlan.translationMode === 'whole-page' && !firstBatchDone,
      modeReason: modePlan.modeReason,
      sourceChars: modePlan.sourceChars,
      unitCount: modePlan.unitCount
    };
  }
}

/** 纯函数：便于测试和遥测复核，不猜模型型号，也不做语义判断。 */
export function decideTranslationMode(
  units,
  {
    preferWholePage = true,
    maxSourceChars = LIMITS.WHOLE_PAGE_MAX_SOURCE_CHARS,
    maxItems = LIMITS.WHOLE_PAGE_MAX_ITEMS
  } = {}
) {
  const list = Array.isArray(units) ? units : [];
  const sourceChars = list.reduce((sum, unit) => sum + String(unit?.text || '').length, 0);
  const unitCount = list.length;
  let modeReason = 'within-safe-range';
  let translationMode = 'whole-page';

  if (!preferWholePage) {
    translationMode = 'chunked';
    modeReason = 'user-disabled';
  } else if (sourceChars > maxSourceChars) {
    translationMode = 'chunked';
    modeReason = 'source-char-limit';
  } else if (unitCount > maxItems) {
    translationMode = 'chunked';
    modeReason = 'unit-count-limit';
  } else if (!unitCount) {
    translationMode = 'chunked';
    modeReason = 'no-content';
  }

  return { translationMode, modeReason, sourceChars, unitCount, maxSourceChars, maxItems };
}
