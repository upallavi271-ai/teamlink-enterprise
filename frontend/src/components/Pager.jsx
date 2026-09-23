// ---------------------------------------------------------------------------
// PAGING FOR THE LONG LISTS.
//
// "490 requirements — illaa last ki vellalsi vasthundhi": every table rendered
// every row, so reaching the bottom of Requirements meant scrolling past 490
// of them, and the imported data has since made that 1,900 requirements, 6,300
// candidates and 12,600 applications. A table that renders 12,600 rows is not
// slow, it is unusable — and the browser has to lay out every one of them
// before the screen paints at all.
//
// DELIBERATELY A HOOK PLUS A COMPONENT, not a <DataTable> that takes a column
// config. Every list in this app has its own markup — cells with status pills,
// links, buttons, inline forms — and rewriting all of them into one component's
// idea of a column would be a large change to screens that already work. This
// way a table gets paging in three lines and its own JSX is untouched:
//
//     const page = usePaged(rows);
//     <div className="tbl-wrap tbl-fit"> … {page.slice.map(…)} … </div>
//     <Pager page={page} noun="requirements" />
//
// PAIRED WITH .tbl-fit IN styles.css, which caps the table's height to the
// window and makes the header sticky. Paging alone would still leave 25 rows
// pushing the controls off the bottom on a short window; together, the header
// stays put, the rows scroll inside their own box, and the pager is always
// where you left it.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';

export const PAGE_SIZES = [25, 50, 100, 250];

export function usePaged(rows, initialSize = 25) {
  const list = Array.isArray(rows) ? rows : [];
  const [size, setSize] = useState(initialSize);
  const [page, setPage] = useState(1);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));

  // BACK TO PAGE ONE WHEN THE RESULTS CHANGE. Filter 490 rows down to 12 while
  // sitting on page 8 and the table would otherwise show nothing at all, which
  // reads as "no results" rather than "you are past the end".
  useEffect(() => { setPage(1); }, [total, size]);

  const current = Math.min(page, pages);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(current * size, total);
  const slice = useMemo(() => list.slice((current - 1) * size, current * size), [rows, current, size]);

  return {
    slice, total, pages, size, setSize, page: current, setPage, from, to,
    // Offset of the first row on this page, so a list that numbers its rows
    // can carry on counting across pages instead of restarting at 1.
    offset: (current - 1) * size,
  };
}

export default function Pager({ page, noun = 'rows', className = '' }) {
  if (!page) return null;
  const { total, pages, size, setSize, page: current, setPage, from, to } = page;

  // Up to seven page buttons, always including the first and last, with gaps
  // marked. 78 pages of candidates cannot be 78 buttons.
  const numbers = [];
  if (pages <= 7) {
    for (let i = 1; i <= pages; i += 1) numbers.push(i);
  } else if (current <= 4) {
    numbers.push(1, 2, 3, 4, 5, '…', pages);
  } else if (current >= pages - 3) {
    numbers.push(1, '…', pages - 4, pages - 3, pages - 2, pages - 1, pages);
  } else {
    numbers.push(1, '…', current - 1, current, current + 1, '…', pages);
  }

  return (
    <div className={`pager ${className}`}>
      <div className="pager-count">
        {total === 0
          ? `No ${noun}`
          : <>Showing <strong>{from.toLocaleString()}–{to.toLocaleString()}</strong> of <strong>{total.toLocaleString()}</strong> {noun}</>}
      </div>

      {pages > 1 && (
        <div className="pager-nav">
          <button type="button" className="pager-btn" disabled={current === 1} onClick={() => setPage(current - 1)} aria-label="Previous page">‹</button>
          {numbers.map((n, i) => (n === '…'
            ? <span key={`gap${i}`} className="pager-gap">…</span>
            : (
              <button
                key={n}
                type="button"
                className={`pager-btn${n === current ? ' active' : ''}`}
                onClick={() => setPage(n)}
                aria-current={n === current ? 'page' : undefined}
              >
                {n}
              </button>
            )))}
          <button type="button" className="pager-btn" disabled={current === pages} onClick={() => setPage(current + 1)} aria-label="Next page">›</button>
        </div>
      )}

      {total > PAGE_SIZES[0] && (
        <label className="pager-size">
          Rows
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
