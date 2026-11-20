import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import FilterBar, { useUrlFilters, keysOfConfig } from '../../components/ats/FilterBar.jsx';
import ExportMenu from '../../components/ExportMenu.jsx';
import { GroupRows, fmtN } from '../../components/search/SearchResults.jsx';
import { useHistoryOpener } from '../../components/search/historyOpen.jsx';
import { personOptions, useAtsWorkers } from '../../components/PeopleFilter.jsx';
import '../../components/search/search.css';

// ---------------------------------------------------------------------------
// THE FULL RESULTS PAGE of the one search (Enter in either search box), and a browse-by-filter screen.
//   - The History groups (People, Clients, Requirements, Candidates) come FIRST, directly under the box; the older record lists (interviews, offers and
//     joinings, invoices and agreements, other) come below, collapsed, with their counts. Every count is the true one, "Show more" fetches the next page.
//   - A client / requirement / recruiter / TL / BDE search also lists THEIR candidates (each row says why it matched, with the step).
//   - The shared FILTER BAR (components/ats/FilterBar.jsx): Type, dates, status, owner, matched by, client, department, location, source, and (for a login
//     that may read pay) CTC, notice; experience, skills. Chips, Clear all, counts per option, all in the address with ?q= and ?open=; a filter alone (no words)
//     lists the matching records. Excel of the filtered results (the ATS Reports export right, written to the export log).
//   - A click opens the complete history in the side drawer OVER this page (components/search/HistoryDrawer.jsx); Up / Down move, Enter opens.
// GET /api/ats/history/search. Only what this login may see is ever sent.
// ---------------------------------------------------------------------------
const HISTORY_GROUPS = ['people', 'clients', 'requirements', 'candidates'];
const TYPE_OPTIONS = [['people', 'People'], ['clients', 'Clients'], ['requirements', 'Requirements'], ['candidates', 'Candidates'], ['events', 'Interviews, offers & joinings'], ['money', 'Invoices & agreements']].map(([value, label]) => ({ value, label }));
const STATUS_OPTIONS = [['joined', 'Joined (still working)'], ['selected', 'Selected'], ['dropped', 'Dropped (rejected or left)'], ['active', 'In process']].map(([value, label]) => ({ value, label }));
const BY_OPTIONS = [['name', 'Name / number'], ['client', 'Client'], ['requirement', 'Requirement'], ['recruiter', 'Recruiter'], ['tl', 'TL'], ['bde', 'BDE']].map(([value, label]) => ({ value, label }));

const configOf = (viewer, owners, facets = {}) => [
  { id: 'type', label: 'Type', type: 'select', primary: true, keys: { value: 'type' }, allLabel: 'All types', options: facets.type || TYPE_OPTIONS },
  { id: 'added', label: 'Added / created', type: 'daterange', primary: true, keys: { from: 'from', to: 'to' } },
  { id: 'status', label: 'Status / step', type: 'select', primary: true, keys: { value: 'status' }, allLabel: 'Any step', options: facets.status || STATUS_OPTIONS },
  { id: 'owner', label: 'Owner (recruiter, TL, BDE)', type: 'select', primary: true, show: owners.length > 0, keys: { value: 'owner' }, allLabel: 'Anyone', options: owners },
  { id: 'by', label: 'Matched by', type: 'select', primary: true, keys: { value: 'by' }, allLabel: 'Anything', options: facets.by || BY_OPTIONS },
  { id: 'client', label: 'Client', type: 'text', keys: { value: 'client' }, placeholder: 'client name' },
  { id: 'dept', label: 'Department', type: 'text', keys: { value: 'dept' }, placeholder: 'e.g. IT' },
  { id: 'loc', label: 'Location', type: 'text', show: !viewer.limited, keys: { value: 'loc' }, placeholder: 'city' },
  { id: 'src', label: 'Source', type: 'text', keys: { value: 'src' }, placeholder: 'e.g. Naukri' },
  { id: 'exp', label: 'Experience', type: 'range', unit: 'years', step: 0.5, keys: { min: 'expMin', max: 'expMax' } },
  { id: 'skills', label: 'Skills', type: 'text', keys: { value: 'skills' }, placeholder: 'e.g. Java, SQL' },
  { id: 'ctc', label: 'Expected CTC', type: 'range', show: !!viewer.pay, unit: 'lakh / year', step: 0.5, keys: { min: 'ctcMin', max: 'ctcMax' } },
  { id: 'notice', label: 'Notice period', type: 'text', show: !!viewer.pay, keys: { value: 'notice' }, placeholder: 'e.g. 30' },
];
const ALL_KEYS = keysOfConfig(configOf({ pay: true }, [{ value: 'x', label: 'x' }], {}));

export default function Search() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') || '';
  const [q, setQ] = useState(urlQ);
  const xf = useUrlFilters(ALL_KEYS);
  const [tab, setTab] = useState('all');
  const [more, setMore] = useState({});
  const [extra, setExtra] = useState({});
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);
  const workers = useAtsWorkers();
  const openHistory = useHistoryOpener();
  const owners = useMemo(() => {
    const one = (role, word) => personOptions(workers, role).filter((o) => o.person && o.person.userId).map((o) => ({ value: o.person.userId, label: `${o.label} (${word})` }));
    return [...one('RECRUITER', 'recruiter'), ...one('TL', 'TL'), ...one('BDE', 'BDE')];
  }, [workers]);
  const viewer = (data && data.viewer) || {};
  const facets = (data && data.facets) || {};
  const config = useMemo(() => configOf(viewer, owners, facets), [viewer.pay, viewer.limited, owners, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterKey = JSON.stringify(xf.values);
  const hasFilter = Object.keys(xf.values).length > 0;

  useEffect(() => { setQ(urlQ); }, [urlQ]);
  useEffect(() => {
    if (urlQ.trim().length < 2 && !hasFilter) { setData(null); setError(''); return undefined; }
    const c = new AbortController();
    setBusy(true); setError(''); setExtra({});
    api.get('/ats/history/search', { params: { q: urlQ, ...xf.values }, signal: c.signal })
      .then((r) => { setData(r.data); setBusy(false); setActive(-1); })
      .catch((e) => {
        if (c.signal.aborted || e.code === 'ERR_CANCELED') return;
        setData(null); setError(e.response?.data?.error || 'Search failed: the server did not answer.'); setBusy(false);
      });
    return () => c.abort();
  }, [urlQ, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Show more": the next page of one group (nothing is cut silently)
  const showMore = (g) => {
    const loaded = g.rows.length + ((extra[g.id] && extra[g.id].rows.length) || 0);
    api.get('/ats/history/search', { params: { q: urlQ, ...xf.values, group: g.id, offset: loaded, limit: 24 } })
      .then((r) => {
        const got = (r.data.groups || [])[0];
        if (got) setExtra((cur) => ({ ...cur, [g.id]: { rows: [...((cur[g.id] && cur[g.id].rows) || []), ...got.rows], more: got.more } }));
      })
      .catch(() => {});
  };

  const groups = ((data && data.groups) || []).map((g) => (extra[g.id] ? { ...g, rows: [...g.rows, ...extra[g.id].rows], more: extra[g.id].more } : g));
  const first = groups.filter((g) => HISTORY_GROUPS.includes(g.id));
  const rest = groups.filter((g) => !HISTORY_GROUPS.includes(g.id));
  const shown = tab === 'all' ? [...first, ...rest.filter((g) => more[g.id])] : groups.filter((g) => g.id === tab);
  const flat = shown.flatMap((g) => g.rows.map((r) => ({ r, g })));
  const total = groups.reduce((n, g) => n + g.count, 0);
  const submit = (e) => {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    const next = new URLSearchParams(params);
    next.set('q', t); next.delete('open'); next.delete('focus');
    setParams(next);
  };
  const open = (row, g) => openHistory(row, { list: g ? g.rows : [row] }) || window.location.assign(row.to);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? Math.min(flat.length - 1, i + 1) : -1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? Math.max(0, i - 1) : -1)); } else if (e.key === 'Enter' && active >= 0 && flat[active]) {
      e.preventDefault();
      open(flat[active].r, flat[active].g);
    }
  };
  useEffect(() => {
    if (active < 0) return;
    const el = document.getElementById(`srp-opt-${active}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const exportParams = { q: urlQ, ...xf.values };
  return (
    <div className="srp">
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <div className="page-sub">Candidates, recruiters, TLs, clients, requirements, interviews, offers, joinings, invoices, agreements, follow-ups, documents. Every result opens its complete history, right here beside the results. Use the filters on their own to browse.</div>
        </div>
        {data && data.canExport && total > 0 && <ExportMenu url="/ats/history/search/export" params={exportParams} formats={['xlsx', 'csv']} label="Download Excel" />}
      </div>
      <form className="filter-row" onSubmit={submit}>
        <input
          style={{ flex: 1 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search anything: candidate, recruiter, TL, client, requirement, phone, invoice…"
          aria-label="Search"
          autoFocus
        />
        <button className="btn btn-sm btn-primary" type="submit" disabled={!q.trim() || busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      <FilterBar
        config={config}
        values={xf.values}
        onChange={xf.set}
        facets={facets}
        loading={busy}
        total={data ? total : null}
        noun="results"
        onClear={xf.clear}
        storageKey="ats-search"
      />
      {data && (
        <div className="srp-tabs">
          <button type="button" className={`btn btn-sm${tab === 'all' ? ' btn-primary' : ''}`} onClick={() => setTab('all')}>All ({fmtN(total)})</button>
          {groups.map((g) => <button key={g.id} type="button" className={`btn btn-sm${tab === g.id ? ' btn-primary' : ''}`} onClick={() => setTab(g.id)}>{g.title} ({fmtN(g.count)})</button>)}
        </div>
      )}
      {error && <div className="notice red">{error}</div>}
      {data && (groups.length === 0
        ? <div className="small-muted">Nothing in your scope matches{urlQ ? ` “${urlQ}”` : ' these filters'}.</div>
        : (
          <>
            <div className="srp-list" role="listbox" data-testid="results-list">
              <GroupRows groups={shown} active={active} idPrefix="srp-opt" onOpen={open} onHover={setActive} />
            </div>
            {shown.filter((g) => g.more).map((g) => (
              <button key={g.id} type="button" className="btn btn-sm srp-morebtn" style={{ marginTop: 8 }} onClick={() => showMore(g)}>
                Show more {g.title.toLowerCase()} ({fmtN(Math.max(0, g.count - g.rows.length))} left)
              </button>
            ))}
            {tab === 'all' && rest.length > 0 && (
              <div className="srp-more">
                <div className="small-muted" style={{ margin: '12px 0 6px' }}>Other records</div>
                {rest.map((g) => (
                  <button key={g.id} type="button" className="btn btn-sm srp-morebtn" aria-expanded={!!more[g.id]} onClick={() => setMore({ ...more, [g.id]: !more[g.id] })}>
                    {more[g.id] ? '▾' : '▸'} {g.title} ({fmtN(g.count)})
                  </button>
                ))}
              </div>
            )}
          </>
        ))}
      {!data && !busy && !error && <div className="small-muted">Type at least two letters or digits: a name, phone number (any format), email, ID, client, requirement code, invoice number… A small spelling slip is forgiven. Or pick a filter to browse.</div>}
    </div>
  );
}
