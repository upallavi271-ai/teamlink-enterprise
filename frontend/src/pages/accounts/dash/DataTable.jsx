import { Fragment, useMemo, useState } from 'react';
import ScrollSync from '../../../components/accounts/ScrollSync.jsx';
import Pager, { usePaged } from '../../../components/Pager.jsx';

// ---------------------------------------------------------------------------
// One wide table for the Accounts Dashboard: its own search, click-to-sort
// headers, pagination, a visible horizontal scrollbar (ScrollSync: synced
// top + bottom bars, the header row and TOTAL row stay on screen), and the
// first column pinned left.
//
//   columns  [{ key, label, num, get(r) -> sort value, render(r), foot, nosort }]
//   rows     the rows (already filtered by the page filters)
//   search   (r) -> text the box searches; omit to hide the box
//   expand   { isOpen(r), toggle(r), render(r) } — a row opens in place
// ---------------------------------------------------------------------------
export default function DataTable({
  columns, rows, rowKey = (r) => r.id, search, placeholder = 'Search this table…', noun = 'rows',
  empty = 'Nothing to show for these filters.', foot, expand, initialSort, pageSize = 25, rowClass,
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort || null); // { key, dir }
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    let out = rows || [];
    if (t && search) out = out.filter((r) => t.split(/\s+/).every((w) => String(search(r) || '').toLowerCase().includes(w)));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      const get = col && (col.get || ((r) => r[col.key]));
      if (get) {
        const mul = sort.dir === 'asc' ? 1 : -1;
        out = [...out].sort((a, b) => {
          const x = get(a); const y = get(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * mul;
        });
      }
    }
    return out;
  }, [rows, q, sort, columns, search]);
  const page = usePaged(list, pageSize);
  const clickSort = (c) => {
    if (c.nosort) return;
    setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.num ? 'desc' : 'asc' }));
  };
  const cls = (c, i) => [c.num ? 'num' : '', i === 0 ? 'acd-sticky' : '', c.className || ''].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      {(search || list.length > pageSize) && (
        <div className="acd-tt">
          {search && <input type="search" value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />}
          <span className="acd-tt-n">{list.length.toLocaleString('en-IN')} {noun}</span>
        </div>
      )}
      <ScrollSync className="acd-tbl" deps={[columns.length, page.slice.length, expand && page.slice.filter((r) => expand.isOpen(r)).length]}>
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className={[cls(c, i), c.nosort ? 'nosort' : ''].filter(Boolean).join(' ')}
                  onClick={() => clickSort(c)}
                  aria-sort={sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={c.nosort ? undefined : 'Click to sort'}
                >
                  {c.label}
                  {sort && sort.key === c.key && <span className="acd-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const open = expand && expand.isOpen(r);
              return (
                <Fragment key={rowKey(r)}>
                  <tr
                    className={[expand ? 'acd-click' : '', open ? 'acd-open' : '', rowClass ? rowClass(r) : ''].filter(Boolean).join(' ') || undefined}
                    onClick={expand ? (e) => { if (!e.target.closest('button,a,input,select,label')) expand.toggle(r); } : undefined}
                  >
                    {columns.map((c, i) => <td key={c.key} className={cls(c, i)}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
                  </tr>
                  {open && (
                    <tr><td className="acd-drill" colSpan={columns.length}><div className="acd-drill-in">{expand.render(r)}</div></td></tr>
                  )}
                </Fragment>
              );
            })}
            {!list.length && <tr><td colSpan={columns.length} className="acd-empty">{q ? 'Nothing matches this search.' : empty}</td></tr>}
          </tbody>
          {foot && list.length > 0 && (
            <tfoot>
              <tr>{columns.map((c, i) => <td key={c.key} className={cls(c, i)}>{c.foot ? c.foot(list) : ''}</td>)}</tr>
            </tfoot>
          )}
        </table>
      </ScrollSync>
      {list.length > pageSize && <Pager page={page} noun={noun} />}
    </div>
  );
}
