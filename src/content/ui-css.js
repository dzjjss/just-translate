/**
 * 页面内界面的样式。写成 JS 字符串是为了塞进 Shadow DOM ——
 * insertCSS 进不去 shadow root，而 fetch + adoptedStyleSheets 会让挂载变成异步、
 * 还多一条失败路径。这点不便换来的是站点 CSS 完全打不进来。
 *
 * 内部一律用 px：站点常把 html 的 font-size 改成 62.5%，rem/em 在 shadow 里照样被带跑。
 */

export const FAB_CSS = `
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
  border: 0;
  border-radius: 12px;
  background: #f2783c;
  color: #fff;
  cursor: grab;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  opacity: 0.72;
  transition: opacity 0.15s ease, transform 0.15s ease;
  touch-action: none;
  padding: 0;
}
.btn:hover { opacity: 1; transform: scale(1.06); }
.btn:active { cursor: grabbing; }
:host([data-running='1']) .btn { opacity: 1; animation: breathe 1.4s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { box-shadow: 0 4px 14px rgba(242, 120, 60, 0.36); }
  50% { box-shadow: 0 4px 22px rgba(242, 120, 60, 0.72); }
}

.menu {
  position: absolute;
  right: 0;
  bottom: 48px;
  min-width: 108px;
  padding: 5px;
  border-radius: 10px;
  background: #14151f;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
:host([data-pos='top']) .menu { bottom: auto; top: 48px; }
.menu button {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #e8e8f4;
  font: 12px/1.4 ui-sans-serif, "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.menu button:hover { background: rgba(255, 255, 255, 0.1); }

.tip {
  position: absolute;
  right: 48px;
  bottom: 4px;
  max-width: 200px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #b3261e;
  color: #fff;
  font: 11.5px/1.4 ui-sans-serif, "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}

@media (prefers-reduced-motion: reduce) {
  :host([data-running='1']) .btn { animation: none; }
  .btn { transition: none; }
}
`;

export const HUD_CSS = `
:host { right: 16px; bottom: 16px; }

.panel {
  width: 248px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #14151f;
  color: #f2f2f7;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  font: 12px/1.45 ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.row { display: flex; align-items: center; gap: 7px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #f2783c; flex: none; }
:host([data-phase='translating']) .dot,
:host([data-phase='scanning']) .dot { animation: pulse 1.1s ease-in-out infinite; }
:host([data-phase='done']) .dot { background: #2fbf8f; }
:host([data-phase='error']) .dot,
:host([data-phase='partial']) .dot { background: #e0703a; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

.text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ver { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; opacity: 0.55; letter-spacing: 0.02em; }
.track { height: 2px; margin: 8px 0; border-radius: 2px; background: rgba(255,255,255,0.13); overflow: hidden; }
.track i { display: block; height: 100%; width: 0; background: #f2783c; transition: width 0.25s ease; }

.ctx { margin-bottom: 8px; gap: 6px; }
.preset {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  color: #e8e8f4;
  font: inherit;
  cursor: pointer;
}
.reason {
  flex: none;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(242,120,60,0.28);
  color: #ffd5bd;
  font-size: 10.5px;
  white-space: nowrap;
}
.reason[data-weak='1'] { background: rgba(224,112,58,0.3); color: #ffd0b8; }

.actions { flex-wrap: wrap; gap: 5px; }
.actions button {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: rgba(255,255,255,0.08);
  color: #cfcfe4;
  font: inherit;
  cursor: pointer;
}
.actions button:hover { background: rgba(255,255,255,0.16); color: #fff; }
.actions button[data-act='close'] { margin-left: auto; padding: 3px 7px; }

@media (prefers-reduced-motion: reduce) {
  .dot { animation: none !important; }
  .track i { transition: none; }
}
`;
