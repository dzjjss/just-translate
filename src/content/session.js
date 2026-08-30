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
  let active = true;
  const units = new Map();
  let trail = [];
  let profile = null;
  let bypassCache = false;
  const tokens = { input: 0, output: 0, cachedUnits: 0 };
  let errorStreak = { msg: '', count: 0 };
  let drift = [];
  let total = 0;
  let done = 0;
  let failed = 0;
  let gate = null;
  let gateGeneration = 0;
  let preflightGeneration = 0;

  const session = {
    id,
    units,

    isActive: () => active,

    invalidate() {
      active = false;
      gateGeneration++;
      preflightGeneration++;
      gate = null;
    },

    registerUnit(unit) {
      units.set(unit.id, unit);
      total++;
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

    markDone(delta = 1) {
      done = Math.max(0, done + delta);
    },

    markFailed(delta = 1) {
      failed = Math.max(0, failed + delta);
    },

    addUsage(usage) {
      if (!usage) return;
      tokens.input += usage.input || 0;
      tokens.output += usage.output || 0;
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
        isCurrent: () => active && preflightGeneration === generation
      };
    },

    /**
     * gate 的 identity 也由 session 自己管理。旧 gate finally 只能清自己，不能把后来
     * 建立的新 gate 清掉；这正是 SPA 快速换页时最容易发生的竞态。
     */
    beginGate(task) {
      if (!active) return Promise.resolve(null);
      const generation = ++gateGeneration;
      let current;
      current = Promise.resolve()
        .then(task)
        .finally(() => {
          if (!active) return;
          if (gateGeneration === generation && gate === current) gate = null;
        });
      gate = current;
      return current;
    },

    async waitForGate() {
      // 等待期间 gate 可能被“重置画像 → 新预检”替换。只 await 一次会在旧 gate
      // 返回后直接放行，把新 gate 绕过去；所以一直跟到当前 gate 真正为空为止。
      while (active) {
        const current = gate;
        if (!current) return true;
        await current;
        if (!active) return false;
        if (gate === current) return true;
      }
      return false;
    }
  };

  Object.defineProperties(session, {
    total: { enumerable: true, get: () => total },
    done: { enumerable: true, get: () => done },
    failed: { enumerable: true, get: () => failed },
    profile: { enumerable: true, get: () => profile },
    drift: { enumerable: true, get: () => drift },
    tokens: { enumerable: true, get: () => ({ ...tokens }) },
    bypassCache: { enumerable: true, get: () => bypassCache },
    gate: { enumerable: true, get: () => gate }
  });

  return Object.freeze(session);
}
