import { ACTION_FEEDBACK_CSS } from '../shared/action-feedback-css.js';
/**
 * 页面内界面的样式。写成 JS 字符串是为了塞进 Shadow DOM ——
 * insertCSS 进不去 shadow root，而 fetch + adoptedStyleSheets 会让挂载变成异步、
 * 还多一条失败路径。这点不便换来的是站点 CSS 完全打不进来。
 *
 * 内部一律用 px：站点常把 html 的 font-size 改成 62.5%，rem/em 在 shadow 里照样被带跑。
 */

const SHELL_CSS = `
:host {
  --jt-paper: #fffaf2;
  --jt-soft: #eee6d8;
  --jt-ink: #292520;
  --jt-muted: #6b6053;
  --jt-line: #8f806e;
  --jt-accent: #ad4825;
  --jt-edge: 0 0 0 1px #fffaf2, 0 6px 20px rgba(28, 23, 17, 0.2);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, select { color-scheme: light; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--jt-accent); outline-offset: 2px; }
@media (forced-colors: active) {
  :host {
    --jt-paper: Canvas; --jt-soft: Canvas; --jt-ink: CanvasText; --jt-muted: CanvasText;
    --jt-line: ButtonText; --jt-accent: Highlight; --jt-edge: none;
  }
}
`;
export const FAB_CSS = SHELL_CSS + ACTION_FEEDBACK_CSS + `
.fab-shell {
  position: fixed;
  z-index: 2147483647;
  right: 18px;
  bottom: 76px;
  width: 40px;
  height: 40px;
  overflow: visible;
  pointer-events: auto;
}
:host([data-pos='middle']) .fab-shell { bottom: auto; top: 50%; }
:host([data-pos='top']) .fab-shell { bottom: auto; top: 88px; }
:host([data-dragging='1']) .fab-shell { transition: none; }

.btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--jt-line);
  border-radius: 12px;
  background: var(--jt-paper);
  color: var(--jt-accent);
  cursor: grab;
  box-shadow: var(--jt-edge);
  transition: transform 0.15s ease;
  touch-action: none;
  padding: 0;
}
.btn:hover { background: var(--jt-soft); transform: scale(1.04); }
.btn:active { cursor: grabbing; }
:host([data-running='1']) .btn svg { animation: breathe 1.4s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.menu {
  position: absolute;
  right: 0;
  bottom: 48px;
  min-width: 140px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--jt-line);
  background: var(--jt-paper);
  box-shadow: var(--jt-edge);
}
:host([data-pos='top']) .menu { bottom: auto; top: 48px; }
.menu button {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--jt-ink);
  font: 13px/1.5 ui-sans-serif, "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.menu button:hover { background: var(--jt-soft); }

.tip {
  position: absolute;
  right: 48px;
  bottom: 4px;
  max-width: 200px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--jt-line);
  background: var(--jt-paper);
  color: var(--jt-ink);
  font: 13px/1.5 ui-sans-serif, "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: var(--jt-edge);
}

@media (prefers-reduced-motion: reduce) {
  :host([data-running='1']) .btn svg { animation: none; }
  .btn { transition: none; }
}
`;

export const HUD_CSS = SHELL_CSS + ACTION_FEEDBACK_CSS + `
/* 给右侧悬浮按钮保留固定通道，无需互相订阅位置状态。 */
:host { right: 76px; bottom: 16px; }

.panel {
  width: 284px;
  max-width: calc(100vw - 92px);
  padding: 12px;
  border: 1px solid var(--jt-line);
  border-radius: 12px;
  background: var(--jt-paper);
  color: var(--jt-ink);
  box-shadow: var(--jt-edge);
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.row { display: flex; align-items: center; gap: 7px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--jt-accent); flex: none; }
:host([data-phase='translating']) .dot,
:host([data-phase='scanning']) .dot { animation: pulse 1.1s ease-in-out infinite; }
:host([data-phase='done']) .dot { background: #287253; }
:host([data-phase='error']) .dot,
:host([data-phase='partial']) .dot { background: var(--jt-accent); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

.text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ver { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--jt-muted); letter-spacing: 0.02em; }
.track { height: 3px; margin: 10px 0; border-radius: 2px; background: var(--jt-soft); overflow: hidden; }
.track i { display: block; height: 100%; width: 0; background: var(--jt-accent); transition: width 0.25s ease; }

.ctx { margin-bottom: 8px; gap: 6px; }
.preset {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  padding: 5px 7px;
  border: 1px solid var(--jt-line);
  border-radius: 6px;
  background: var(--jt-paper);
  color: var(--jt-ink);
  font: inherit;
  cursor: pointer;
}
.reason {
  flex: none;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--jt-soft);
  color: var(--jt-muted);
  font-size: 12px;
  white-space: nowrap;
}
.reason[data-weak='1'] { color: var(--jt-accent); }

.actions { flex-wrap: wrap; gap: 5px; }
.actions button {
  min-height: 32px;
  padding: 4px 7px;
  border: 1px solid var(--jt-line);
  border-radius: 6px;
  background: var(--jt-paper);
  color: var(--jt-ink);
  font: inherit;
  cursor: pointer;
}
.actions button:hover { background: var(--jt-soft); }
.actions button[data-act='close'] { margin-left: auto; padding: 3px 7px; }

@media (prefers-reduced-motion: reduce) {
  .dot { animation: none !important; }
  .track i { transition: none; }
}
`;
