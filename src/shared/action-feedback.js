/** UI deadlines do not cancel or replay background work. Late replies are ignored. */
export function waitForReply(promise, ms = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待超时，操作可能仍在后台执行，请确认结果后重试')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const jobs = new WeakMap();
const locks = new Set();

export const actionPending = button => Boolean(jobs.get(button)?.pending);

function paint(button, state, label) {
  button.dataset.feedback = state;
  button.dataset.feedbackLabel = label;
  button.setAttribute('aria-label', `${button.dataset.actionName}: ${label}`);
  button.setAttribute('aria-busy', String(state === 'busy'));
}

function restore(button, record) {
  if (jobs.get(button) !== record) return;
  delete button.dataset.feedback;
  delete button.dataset.feedbackLabel;
  delete button.dataset.feedbackCompact;
  button.removeAttribute('aria-busy');
  if (record.ariaLabel === null) button.removeAttribute('aria-label');
  else button.setAttribute('aria-label', record.ariaLabel);
  jobs.delete(button);
}

/** A changed draft makes the previous success badge obsolete. Never unlock an active request. */
export function resetActionFeedback(button) {
  const record = jobs.get(button);
  if (!record || record.pending) return;
  clearTimeout(record.timer);
  restore(button, record);
}

function outcome(result, options, translate) {
  const failed = result?.ok === false;
  const tone = failed ? 'error' : result?.tone || 'success';
  const label = translate(result?.label || (failed ? options.failure || '未完成' : options.success || '已完成'));
  return { tone, label, message: result?.message || result?.error?.message || label };
}

function begin(button, group) {
  const previous = jobs.get(button);
  clearTimeout(previous?.timer);
  if (previous) restore(button, previous);
  const record = { pending: true, ariaLabel: button.getAttribute('aria-label'), timer: null };
  button.dataset.actionName = button.getAttribute('aria-label') || button.textContent.trim();
  if (button.getBoundingClientRect().width < 64) button.dataset.feedbackCompact = 'true';
  jobs.set(button, record);
  locks.add(group);
  button.disabled = true;
  return record;
}

/** Each surface owns one notice; an older operation cannot overwrite a newer one. */
export function createActionFeedback({ translate = text => text, announce = () => {} } = {}) {
  let sequence = 0;

  function beginNotice(message, tone = 'busy') {
    const ticket = ++sequence;
    const report = (text, state = 'success') => {
      if (ticket === sequence) announce(translate(text), state);
    };
    report(message, tone);
    return report;
  }

  function notice(message, tone = 'success') { beginNotice(message, tone); }

  async function run(button, task, options = {}) {
    const group = options.group || button;
    if (button.disabled || actionPending(button)) return;
    if (locks.has(group)) {
      announce(translate('同类操作仍在处理中，请稍候'), 'warning');
      return;
    }
    const ticket = ++sequence;
    const record = begin(button, group);
    const notify = (message, tone) => {
      if (sequence === ticket) announce(translate(message), tone);
    };
    const pending = translate(options.pending || '处理中…');
    paint(button, 'busy', pending);
    notify(pending, 'busy');
    const slow = setTimeout(() => notify('仍在处理中，请稍候', 'busy'), 12000);
    try {
      // Invoke synchronously, before awaiting: permissions/clipboard need the click gesture.
      const result = await task();
      const { tone, label, message } = outcome(result, options, translate);
      paint(button, tone, label);
      notify(message, tone);
      return result;
    } catch (error) {
      paint(button, 'error', translate(options.failure || '未完成'));
      notify(error?.message ? `${translate('操作未完成，请重试；当前草稿已保留')} · ${translate(error.message)}`
        : '操作未完成，请重试；当前草稿已保留', 'error');
      return { ok: false };
    } finally {
      clearTimeout(slow);
      record.pending = false;
      locks.delete(group);
      button.disabled = false;
      options.onSettled?.();
      record.timer = setTimeout(() => restore(button, record), 2400);
    }
  }

  return { run, notice, beginNotice };
}
