import './crq4.css';

// ---------------------------------------------------------------------------
// Small presentation pieces of the Clients & Requirements v4 screens.
// ---------------------------------------------------------------------------

// The module header: title + subtitle (+ scope line) on the left, the page's
// own tools on the right. The Shell's Clients | Jobs | Agreements strip is
// drawn under it (crq4.css orders it there).
export function CrqHead({ title = 'Clients & Requirements', sub, scope, tools }) {
  return (
    <header className="ak-page-head crq4-head">
      <div className="crq4-head-txt">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
        {scope && <div className="crq4-head-scope">{scope}</div>}
      </div>
      {tools && <div className="ak-page-tools crq4-tools">{tools}</div>}
    </header>
  );
}

// "1–25 of 4,347  ‹ 1 2 3 … 174 ›" for a panel header. `page` is the same
// object the bottom Pager takes ({ page, pages, setPage, from, to, total }).
export function MiniPager({ page }) {
  if (!page || !page.total) return null;
  const { pages, page: cur, setPage, from, to, total } = page;
  const nums = [];
  if (pages <= 6) for (let i = 1; i <= pages; i += 1) nums.push(i);
  else if (cur <= 3) nums.push(1, 2, 3, 4, '…', pages);
  else if (cur >= pages - 2) nums.push(1, '…', pages - 3, pages - 2, pages - 1, pages);
  else nums.push(1, '…', cur - 1, cur, cur + 1, '…', pages);
  const f = (n) => Number(n || 0).toLocaleString('en-IN');
  return (
    <div className="crq4-mpager">
      <span className="crq4-mpager-count">{`${f(from)}–${f(to)} of ${f(total)}`}</span>
      {pages > 1 && (
        <span className="crq4-mpager-nav">
          <button type="button" disabled={cur === 1} onClick={() => setPage(cur - 1)} aria-label="Previous page">‹</button>
          {nums.map((n, i) => (n === '…'
            ? <span key={`g${i}`} className="gap">…</span>
            : <button key={n} type="button" className={n === cur ? 'on' : undefined} aria-current={n === cur ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button>))}
          <button type="button" disabled={cur === pages} onClick={() => setPage(cur + 1)} aria-label="Next page">›</button>
        </span>
      )}
    </div>
  );
}

// The compact filter card: whatever filter controls the page passes, in one row.
export function FilterCard({ children, search }) {
  return (
    <div className="crq4-filters" role="search">
      <div className="crq4-filters-row">
        {children}
        {search && (
          <label className="crq4-search">
            <span className="crq4-search-ic" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            </span>
            <input
              type="search"
              placeholder={search.placeholder}
              value={search.value || ''}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && search.onSubmit) { e.preventDefault(); search.onSubmit(); } }}
              aria-label="Search"
            />
          </label>
        )}
      </div>
    </div>
  );
}
