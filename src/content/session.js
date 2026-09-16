/**
 * 一页一个 PageSession。
 *
 * 这里真正拥有“这一页”的可变状态：units、标题路径、profile、
 * token / 成功失败计数以及 preflight/gate identity。main.js 只能通过方法修改这些状态，
 * 不再拿一个裸全局对象到处 ++ / 赋值。
 */
let sequence = 0;

export function createPageSession() {
  const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  let lifecycle = 'idle';
  const active = () => lifecycle !== 'closed';
  const units = new Map();
  const owners = new WeakMap();
  let trail = [];
  let profile = null;
  let bypassCache = false;
  const tokens = {
    translation: { input: 0, output: 0, incomplete: false },
    preflight: { input: 0, output: 0, incomplete: false },
    cachedUnits: 0
  };
  const totalUsage = () => ({
    input: tokens.translation.input + tokens.preflight.input,
    output: tokens.translation.output + tokens.preflight.output,
    incomplete: tokens.translation.incomplete || tokens.preflight.incomplete
  });
  let errorStreak = { msg: '', count: 0 };
  let drift = [];
  let gate = null;
  let gateGeneration = 0;
  let preflightGeneration = 0;

  const session = {
    id,
    units: Object.freeze({
      get: (key) => units.get(key),
      values: () => units.values(),
      get size() { return units.size; }
    }),

    isActive: active,
    isRunning: () => lifecycle === 'running',
    start() { if (active()) lifecycle = 'running'; },

    invalidate() {
      lifecycle = 'closed';
      gateGeneration++;
      preflightGeneration++;
      gate = null;
    },

    registerUnit(unit) {
      if (unit.node) {
        const previous = owners.get(unit.node);
        if (previous && previous !== unit.id) units.delete(previous);
        owners.set(unit.node, unit.id);
      }
      unit.attempt = 0;
      units.set(unit.id, unit);
    },

    beginAttempt(batch) {
      const attempts = new Map();
      for (const unit of batch) {
        if (units.get(unit.id) !== unit) continue;
        unit.attempt++;
        unit.state = 'pending';
        attempts.set(unit.id, unit.attempt);
      }
      return attempts;
    },

    prepareRetry(unit) {
      if (!active() || !['done', 'error'].includes(unit.state)) return false;
      unit.attempt++;
      unit.state = 'queued';
      return true;
    },

    /** Retire units no longer represented by the current DOM; counters derive from membership. */
    reconcile(snapshot, detach) {
      const current = new Map(snapshot.map(unit => [unit.anchor, unit]));
      let removed = 0;
      for (const [id, unit] of units) {
        const live = current.get(unit.anchor);
        if (live && live.hash === unit.hash && live.node === unit.node) continue;
        units.delete(id);
        detach(unit);
        removed++;
      }
      return removed;
    },

    commit(unit, attempt, state, apply) {
      if (!active() || units.get(unit.id) !== unit || unit.attempt !== attempt) return false;
      if (unit.state !== 'pending') return false;
      if (!apply()) {
        units.delete(unit.id);
        return false;
      }
      unit.state = state;
      return true;
    },

    assignPaths(batch) {
      for (const unit of batch) {
        if (unit.role === 'heading') {
          const level = { H1: 1, H2: 2 }[unit.tag] || 3;
          trail = trail.slice(0, level - 1);
          trail[level - 1] = unit.text.slice(0, 60);
          unit.path = trail.filter(Boolean).slice(0, -1).join(' > ');
        } else {
          unit.path = trail.filter(Boolean).slice(-2).join(' > ');
        }
      }
    },

    setBypassCache(value) {
      bypassCache = Boolean(value);
    },

    addUsage(usage, phase = 'translation', incomplete = false) {
      if (phase !== 'translation' && phase !== 'preflight') throw new Error('Unknown usage phase');
      const bucket = tokens[phase];
      bucket.incomplete ||= Boolean(incomplete);
      for (const key of ['input', 'output']) {
        const value = usage?.[key];
        if (Number.isFinite(value) && value >= 0) bucket[key] += value;
        else if (usage) bucket.incomplete = true;
      }
    },

    addCachedItems(items) {
      for (const item of items || []) if (item?.cached) tokens.cachedUnits++;
    },

    clearError() {
      errorStreak = { msg: '', count: 0 };
    },

    recordError(message) {
      const msg = String(message || '');
      errorStreak = errorStreak.msg === msg
        ? { msg, count: errorStreak.count + 1 }
        : { msg, count: 1 };
      return errorStreak.count;
    },

    setProfile(value) {
      profile = value || null;
    },

    clearProfile() {
      profile = null;
      gateGeneration++;
      preflightGeneration++;
      gate = null;
    },

    setDrift(value) {
      drift = Array.isArray(value) ? value : [];
    },

    /**
     * 同一页也可能连续发起两次预检（例如用户在旧预检未返回时点“重置画像”）。
     * URL 和 sessionId 都相同，只有请求代次能判断谁有资格写 profile。
     */
    beginPreflight() {
      const generation = ++preflightGeneration;
      return {
        generation,
        isCurrent: () => active() && preflightGeneration === generation
      };
    },

    /**
     * gate 的 identity 也由 session 自己管理。旧 gate finally 只能清自己，不能把后来
     * 建立的新 gate 清掉；这正是 SPA 快速换页时最容易发生的竞态。
     */
    beginGate(task) {
      if (!active()) return Promise.resolve(null);
      const generation = ++gateGeneration;
      let current;
      current = Promise.resolve()
        .then(task)
        .finally(() => {
          if (!active()) return;
          if (gateGeneration === generation && gate === current) gate = null;
        });
      gate = current;
      return current;
    },

    async waitForGate() {
      // 等待期间 gate 可能被“重置画像 → 新预检”替换。只 await 一次会在旧 gate
      // 返回后直接放行，把新 gate 绕过去；所以一直跟到当前 gate 真正为空为止。
      while (active()) {
        const current = gate;
        if (!current) return true;
        await current;
        if (!active()) return false;
        if (gate === current) return true;
      }
      return false;
    }
  };

  Object.defineProperties(session, {
    total: { enumerable: true, get: () => units.size },
    done: { enumerable: true, get: () => [...units.values()].filter(u => u.state === 'done').length },
    failed: { enumerable: true, get: () => [...units.values()].filter(u => u.state === 'error').length },
    profile: { enumerable: true, get: () => profile },
    errorMessage: { enumerable: true, get: () => errorStreak.msg },
    drift: { enumerable: true, get: () => drift },
    // One owner, two phase buckets; page totals are always derived.
    tokens: { enumerable: true, get: () => ({
      input: totalUsage().input, output: totalUsage().output, cachedUnits: tokens.cachedUnits
    }) },
    usageByPhase: { enumerable: true, get: () => ({
      translate: { ...tokens.translation }, preflight: { ...tokens.preflight }, total: totalUsage()
    }) },
    bypassCache: { enumerable: true, get: () => bypassCache },
    gate: { enumerable: true, get: () => gate }
  });

  return Object.freeze(session);
}
