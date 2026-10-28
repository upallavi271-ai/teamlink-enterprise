// ID + NAME STAY PUT WHILE A WIDE TABLE SCROLLS SIDEWAYS - EVERY TABLE IN THE APP (founder 2026-10-28:
// "scroll chestunte valla name and employee id kanipinchadam ledu ... employee id and name stick on avvi undali,
// tarvatha unna columns scroll avvali, motha application lo ekkada scroll bar unna").
//
// One watcher for the whole app (installed once in main.jsx). For every <table> whose box really scrolls sideways it
// looks at the first four header cells for the identity columns - a Name / Employee / Candidate column and an ID /
// Code / No. column next to it - and freezes the columns up to them (a tick-box or # column before them comes along),
// so the person's ID and name stay on screen and the rest scrolls under them.
// Left alone: a table with no such header; one that already freezes its own columns in CSS (Clients, Jobs, the
// candidate pipeline, the Accounts sticky tables); one marked data-no-sticky (on it or a parent); a table that does not
// scroll; and frozen columns wider than 45% of the visible box (a phone) - then nothing is frozen.
// Only inline styles it set itself are ever changed or removed (cells carry data-tl-stick).

const NAME = /\b(name|employee|candidate|person|staff|member|recruiter)\b/i;
const ID = /\b(id|code|no\.?|number|emp\.?\s*(id|code|no))\b/i;
const MAX_LOOK = 4; // identity columns are looked for among the first four
const MAX_SHARE = 0.45; // frozen part never wider than this share of the visible box

const isTransparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
function opaqueBg(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (!isTransparent(c)) return c;
  }
  return '#fff';
}

function scrollBox(table) {
  for (let n = table.parentElement, i = 0; n && i < 4; n = n.parentElement, i += 1) {
    const ox = getComputedStyle(n).overflowX;
    if (ox === 'auto' || ox === 'scroll') return n;
  }
  return null;
}

// Each row's cells with the column they start at (colspan counted).
function cellsOf(row) {
  let col = 0;
  return [...row.cells].map((cell) => { const o = { cell, start: col, span: cell.colSpan || 1 }; col += o.span; return o; });
}

function headerRow(table) {
  const head = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
  return head || table.rows[0] || null;
}

// How many leading columns to freeze (0 = none).
function frozenCount(table) {
  const hr = headerRow(table);
  if (!hr) return 0;
  const cells = cellsOf(hr);
  if (cells.some((c) => c.start < MAX_LOOK && c.span > 1)) return 0;
  const text = cells.slice(0, MAX_LOOK).map((c) => (c.cell.textContent || '').trim());
  const identity = (t) => NAME.test(t) || ID.test(t);
  // the first ID / name column (one of the first three; a tick-box or # column may come before it), then the ID / name
  // columns right after it: "Employee ID, Name" / "#, Name, Employee ID" / "Asset ID, Name" / "Name"
  const first = text.findIndex(identity);
  if (first < 0 || first > 2) return 0;
  let n = first + 1;
  while (n < text.length && identity(text[n])) n += 1;
  if (n >= cells.length) return 0; // something must be left to scroll
  return n;
}

const STYLE_KEYS = ['position', 'left', 'zIndex', 'background', 'boxShadow'];
function clearCell(cell) {
  if (!cell.dataset.tlStick) return;
  STYLE_KEYS.forEach((k) => { cell.style[k] = ''; });
  delete cell.dataset.tlStick;
}
function clearTable(table) {
  table.querySelectorAll('[data-tl-stick]').forEach(clearCell);
  delete table.dataset.tlStickCols;
}

// A table that already freezes a column with its own CSS is left exactly as it is.
function ownSticky(table) {
  const hr = headerRow(table);
  const first = hr && hr.cells[0];
  if (!first || first.dataset.tlStick) return false;
  const cs = getComputedStyle(first);
  return cs.position === 'sticky' && cs.left !== 'auto';
}

function applyTable(table) {
  if (table.closest('[data-no-sticky]')) { clearTable(table); return; }
  const box = scrollBox(table);
  if (!box || ownSticky(table)) { clearTable(table); return; }
  const n = box.scrollWidth > box.clientWidth + 2 ? frozenCount(table) : 0;
  if (!n) { clearTable(table); return; }
  // column widths from the header row, then left offsets
  const hr = headerRow(table);
  const hcells = cellsOf(hr);
  const lefts = [];
  let x = 0;
  for (let i = 0; i < n; i += 1) {
    lefts.push(x);
    const c = hcells.find((o) => o.start === i);
    x += c ? c.cell.getBoundingClientRect().width : 0;
  }
  if (x > box.clientWidth * MAX_SHARE) { clearTable(table); return; }
  // 1. the cells to freeze (a row with a cell across the frozen edge - an empty-list row - is left alone)
  const targets = [];
  [...table.rows].forEach((row) => {
    const cells = cellsOf(row);
    if (cells.some((c) => c.start < n && c.start + c.span > n)) return;
    cells.forEach((c) => { if (c.start < n) targets.push({ ...c, row }); });
  });
  // 2. drop the background set last time, then read each cell's own (CSS) colour in one go - a frozen cell must be
  // opaque, so a see-through one takes its row's / table's colour
  targets.forEach((t) => { if (t.cell.dataset.tlStick) t.cell.style.background = ''; });
  const bgs = targets.map((t) => { const own = getComputedStyle(t.cell).backgroundColor; return isTransparent(own) ? opaqueBg(t.row) : own; });
  // 3. write
  const keep = new Set();
  targets.forEach((t, i) => {
    const { cell } = t;
    cell.style.position = 'sticky';
    cell.style.left = `${Math.round(lefts[t.start])}px`;
    cell.style.zIndex = cell.tagName === 'TH' ? '4' : '2';
    cell.style.background = bgs[i];
    cell.style.boxShadow = t.start + t.span === n ? 'inset -1px 0 0 rgba(16,24,40,.12), 6px 0 6px -6px rgba(16,24,40,.18)' : '';
    cell.dataset.tlStick = '1';
    keep.add(cell);
  });
  table.querySelectorAll('[data-tl-stick]').forEach((cell) => { if (!keep.has(cell)) clearCell(cell); });
  table.dataset.tlStickCols = String(n);
}

let queued = false;
function runAll() {
  queued = false;
  document.querySelectorAll('table').forEach((t) => { try { applyTable(t); } catch { /* one odd table never stops the rest */ } });
}
function schedule() {
  if (queued) return;
  queued = true;
  setTimeout(runAll, 120); // a plain timer (requestAnimationFrame waits while the tab is hidden)
}

export function installStickyColumns() {
  if (typeof window === 'undefined' || window.__tlStickyColumns) return;
  window.__tlStickyColumns = true;
  // rows / pages / tabs coming and going (only element changes are watched - the styles set here never wake it up again)
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  schedule();
}

export default installStickyColumns;
