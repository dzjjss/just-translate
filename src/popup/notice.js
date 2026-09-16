/** Popup-only transient notice. Buttons remain the primary progress indicator. */
export function createPopupNotice(container) {
  const message = container.querySelector('[role="status"]');
  const dismissButton = container.querySelector('button');
  let timer = null;
  let returnFocus = null;

  function dismiss() {
    clearTimeout(timer);
    if (container.contains(document.activeElement)) returnFocus?.focus?.();
    container.hidden = true;
  }

  function schedule() {
    clearTimeout(timer);
    if (['error', 'warning'].includes(container.dataset.tone)) return;
    // Long results need more reading time; failures stay until dismissed or replaced.
    timer = setTimeout(dismiss, Math.min(10000, Math.max(3200, message.textContent.length * 70)));
  }

  dismissButton.addEventListener('click', dismiss);
  container.addEventListener('pointerenter', () => clearTimeout(timer));
  container.addEventListener('pointerleave', schedule);
  container.addEventListener('focusin', () => clearTimeout(timer));
  container.addEventListener('focusout', schedule);
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  });

  return (text, tone) => {
    if (!container.contains(document.activeElement)) returnFocus = document.activeElement;
    message.textContent = text;
    message.dataset.tone = tone;
    container.dataset.tone = tone;
    container.hidden = !text;
    if (!container.matches(':hover, :focus-within')) schedule();
    else clearTimeout(timer);
  };
}
