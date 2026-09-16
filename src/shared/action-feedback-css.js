/** Same feedback surface in the popup, HUD and floating menu. Original children stay intact. */
export const ACTION_FEEDBACK_CSS = `
button[data-feedback] {
  position: relative !important;
  color: transparent !important;
  text-shadow: none !important;
  opacity: 1 !important;
}
button[data-feedback] > * { visibility: hidden !important; }
button[data-feedback]::after {
  content: attr(data-feedback-label);
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 4px;
  color: var(--jt-feedback-ink, #292520);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
  pointer-events: none;
}
button[data-feedback='busy'] { cursor: progress; }
button[data-feedback-compact]::after { font-size: 11px; padding: 2px; }
button[data-feedback='busy']::after { color: var(--jt-feedback-busy, #ad4825); }
button[data-feedback='success']::after { color: var(--jt-feedback-success, #287253); }
button[data-feedback='error']::after { color: var(--jt-feedback-error, #a43636); }
button[data-feedback='warning']::after { color: var(--jt-feedback-warning, #865717); }
button[data-feedback='busy']::before {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 2px;
  height: 2px;
  background: var(--jt-feedback-busy, #ad4825);
  transform-origin: left;
  animation: jt-action-wait 1.2s ease-in-out infinite alternate;
}
@keyframes jt-action-wait { from { transform: scaleX(.15); } to { transform: scaleX(1); } }
.jt-action-notice {
  color: var(--jt-feedback-ink, #292520);
  font: 12px/1.5 ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
  overflow-wrap: anywhere;
}
.jt-action-notice[data-tone='error'] { color: var(--jt-feedback-error, #a43636); }
.jt-action-notice[data-tone='warning'] { color: var(--jt-feedback-warning, #865717); }
.jt-action-notice[data-tone='success'] { color: var(--jt-feedback-success, #287253); }
.jt-action-notice[data-tone='busy'] { color: var(--jt-feedback-busy, #ad4825); }
@media (prefers-reduced-motion: reduce) {
  button[data-feedback='busy']::before { animation: none; }
}
@media (forced-colors: active) {
  button[data-feedback], .jt-action-notice {
    --jt-feedback-ink: ButtonText; --jt-feedback-busy: Highlight;
    --jt-feedback-success: ButtonText; --jt-feedback-error: ButtonText; --jt-feedback-warning: ButtonText;
  }
}
`;
