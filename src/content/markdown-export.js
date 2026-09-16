import { closestInPage, parentInPage, renderedChildren } from './dom-roots.js';

// Explicit interface regions only: article asides, references and linked prose remain content.
const INTERFACE = 'nav,[role="navigation"],[role="toolbar"],[role="menu"],button,[role="button"],'
  + 'input,select,textarea,.breadcrumb,.pagination,.mw-editsection,.navbox,#toc,.toc,#byom-hud,#byom-fab';
const OMIT_SOURCE = '.byom-t,script,style,template,button,input,select,textarea,[hidden],[aria-hidden="true"]';

function isContent(unit) {
  if (unit.state !== 'done' || !unit.node?.isConnected || !unit.node.textContent.trim()) return false;
  if (unit.node.dataset?.byomHash && unit.node.dataset.byomHash !== unit.hash) return false;
  if (!unit.el) return true; // Pure-data callers can still export a completed snapshot.
  if (!unit.el.isConnected || unit.role === 'ui' || closestInPage(unit.el, INTERFACE)) return false;
  if (closestInPage(unit.el, '[hidden],[aria-hidden="true"]')) return false;
  const chrome = closestInPage(unit.el, 'header,footer,[role="banner"],[role="contentinfo"]');
  return !chrome || Boolean(closestInPage(chrome, 'main,article,[role="main"]'));
}

function ancestry(node) {
  const path = [];
  for (let current = node; current; current = parentInPage(current)) path.unshift(current);
  return path;
}

function inPageOrder(a, b) {
  let i = 0;
  while (i < a.path.length && a.path[i] === b.path[i]) i++;
  if (!i) return a.index - b.index;
  if (!a.path[i] || !b.path[i]) return a.path.length - b.path.length;
  const siblings = Array.from(renderedChildren(a.path[i - 1]) || []);
  return siblings.indexOf(a.path[i]) - siblings.indexOf(b.path[i]);
}

/** Treat model/source strings as text, never as Markdown or raw HTML. */
function escapeLine(value) {
  return value.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]<>|#!]/g, '\\$&')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3');
}

function text(value) {
  return String(value || '').trim().replace(/\r\n?/g, '\n').split(/\n+/).map(escapeLine).join('\n\n');
}

const singleLine = value => text(String(value || '').replace(/\s+/g, ' '));
const translated = unit => unit.node.textContent.trim();
const closest = (unit, selector) => unit.el ? closestInPage(unit.el, selector) : null;

function listPrefix(unit) {
  const item = closest(unit, 'li');
  const list = item?.parentElement;
  if (list?.tagName !== 'OL') return '- ';
  let number = list.reversed ? (list.hasAttribute('start') ? list.start : list.children.length) : list.start;
  for (const child of list.children) {
    if (child.tagName !== 'LI') continue;
    if (child.hasAttribute('value')) number = child.value;
    if (child === item) return `${number}. `;
    number += list.reversed ? -1 : 1;
  }
  return '- ';
}

function listIndent(unit) {
  let indent = '';
  const item = closest(unit, 'li');
  if (!item) return indent;
  for (let parent = closestInPage(parentInPage(item), 'li'); parent; parent = closestInPage(parentInPage(parent), 'li')) {
    indent += ' '.repeat(listPrefix({ el: parent }).length);
  }
  return indent;
}

function pair(unit, continued = false) {
  const source = text(unit.text);
  const target = text(translated(unit));
  if (closest(unit, 'figcaption,caption') || /^(FIGCAPTION|CAPTION)$/.test(unit.tag)) {
    return `*${singleLine(unit.text)}*\n\n*${singleLine(translated(unit))}*`;
  }
  if (unit.role === 'heading') {
    const level = /^H([1-6])$/.exec(unit.tag)?.[1] || 3;
    return `${'#'.repeat(Number(level))} ${singleLine(unit.text)}\n\n**${singleLine(translated(unit))}**`;
  }
  if (unit.tag === 'LI' || closest(unit, 'li')) {
    const prefix = listPrefix(unit);
    const indent = listIndent(unit);
    const continuation = indent + ' '.repeat(prefix.length);
    return (continued ? continuation : indent + prefix) + source.replace(/\n/g, '\n' + continuation)
      + '\n\n' + continuation + target.replace(/\n/g, '\n' + continuation);
  }
  const result = source + '\n\n' + target;
  return closest(unit, 'blockquote') ? result.split('\n').map(line => '> ' + line).join('\n') : result;
}

function sourceText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.matches(OMIT_SOURCE)) return '';
  const style = node.ownerDocument.defaultView.getComputedStyle(node);
  if (style.visibility === 'hidden' || (style.display === 'none' && !node.hasAttribute('data-byom-src'))) return '';
  if (node.tagName === 'BR') return ' ';
  // Nested tables are exported on their own and must not be flattened into an outer cell.
  if (node.tagName === 'TABLE') return '';
  const content = Array.from(renderedChildren(node)).map(sourceText).join('');
  return /^(P|DIV|LI|H[1-6]|BLOCKQUOTE)$/.test(node.tagName) ? ` ${content} ` : content;
}

function cellText(cell, units) {
  const source = singleLine(sourceText(cell));
  const targets = units.map(unit => text(translated(unit)).replace(/\n+/g, '<br>')).join('<br><br>');
  return targets ? `${source}<br><br>${targets}` : source;
}

function cellUnits(cell, units) {
  return units.filter(unit => closest(unit, 'td,th') === cell);
}

function tableGrid(table, units) {
  const rows = Array.from(table.rows).filter(row => row.closest('table') === table);
  const grid = [];
  const included = [];
  for (const [r, row] of rows.entries()) {
    grid[r] ||= [];
    let column = 0;
    let completed = false;
    for (const cell of row.cells) {
      while (grid[r][column] !== undefined) column++;
      const translations = cellUnits(cell, units);
      completed ||= translations.length > 0;
      const width = Math.min(cell.colSpan || 1, 100);
      const sectionRows = Array.from(row.parentElement.children).filter(el => el.tagName === 'TR');
      const remaining = sectionRows.length - sectionRows.indexOf(row);
      const height = Math.min(cell.rowSpan || remaining, remaining);
      for (let y = r; y < r + height; y++) {
        grid[y] ||= [];
        for (let x = column; x < column + width; x++) grid[y][x] = '';
      }
      grid[r][column] = cellText(cell, translations);
      column += width;
    }
    const heading = row.cells.length > 0 && Array.from(row.cells).every(cell => cell.tagName === 'TH');
    included.push(completed || heading);
  }
  return grid.filter((_, index) => included[index]);
}

function tableBlock(table, units) {
  const captions = units.filter(unit => closest(unit, 'caption')).map(unit => pair(unit));
  const bodyUnits = units.filter(unit => closest(unit, 'td,th'));
  if (!bodyUnits.length) return captions.join('\n\n');
  const grid = tableGrid(table, bodyUnits);
  if (!grid.length) return captions.join('\n\n');
  const columns = Math.max(...grid.map(row => row.length));
  const firstRow = Array.from(table.rows).find(row => row.closest('table') === table);
  const hasHeader = firstRow?.cells.length && Array.from(firstRow.cells).every(cell => cell.tagName === 'TH');
  const header = hasHeader ? grid.shift() : [];
  const rowLine = row => '| ' + Array.from({ length: columns }, (_, i) => row[i] || '').join(' | ') + ' |';
  return [...captions, [rowLine(header), rowLine(Array(columns).fill('---')), ...grid.map(rowLine)].join('\n')].join('\n\n');
}

/** Completed bilingual blocks, ordered by the current composed DOM (including open shadow roots). */
export function buildBilingualMarkdown(units) {
  const seen = new Set();
  const ordered = units.filter(isContent).filter(unit => {
    if (seen.has(unit.node)) return false;
    seen.add(unit.node);
    return true;
  }).map((unit, index) => ({ unit, index, path: ancestry(unit.node) })).sort(inPageOrder).map(row => row.unit);
  const tables = new Set();
  const items = new Set();
  const out = [];
  for (const unit of ordered) {
    const table = closest(unit, 'table');
    if (!table) {
      const item = closest(unit, 'li');
      out.push(pair(unit, item && items.has(item)));
      if (item) items.add(item);
      continue;
    }
    if (tables.has(table)) continue;
    tables.add(table);
    const block = tableBlock(table, ordered.filter(item => closest(item, 'table') === table));
    if (block) out.push(block);
  }
  return out.length ? out.join('\n\n') + '\n' : '';
}
