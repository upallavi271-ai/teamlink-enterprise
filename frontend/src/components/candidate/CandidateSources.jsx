import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import StatCard from '../ui/StatCard.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import Modal from '../Modal.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import { ChartCard, DataTable, BarChart, LineChart } from '../charts';
import { ExportButtons } from '../../pages/reports/ReportBits.jsx';
import { IMPORTED_SOURCE, NOT_RECORDED, sourceLabel, shortDay, longDay } from '../../utils/candidateSource.js';
import './CandidateSources.css';

// ---------------------------------------------------------------------------
// WHERE CANDIDATES COME FROM — the "Sources" tab (user, 2026-10-13):
// "Candidates Ye Source nunchi entha mandi vacharu, eppudu vacharu, clear ga visible avvali."
//
// Big numbers first, then a ranked table (or bars), then "When they came" and
// "Source over time". Every number comes from GET /api/candidates/sources, which
// counts the very rows the People list shows, so a number and the list it opens
// always agree. Nothing here shows a candidate's name, phone, e-mail or salary.
//
// Used in two places: Candidates & Pipeline -> Sources, and ATS Reports -> Where
// candidates come from (embedded).
// ---------------------------------------------------------------------------
const PERIODS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'],
  ['lastmonth', 'Last month'], ['last3', 'Last 3 months'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom'],
];
const GROUPS = [['day', 'Day by day'], ['week', 'Week by week'], ['month', 'Month by month']];
const FILTER_DEFS = [
  ['department', 'Department', 'All departments'],
  ['clientId', 'Client', 'All clients'],
  ['requirementId', 'Requirement', 'All requirements'],
  ['recruiter', 'Recruiter', 'All recruiters'],
  ['tl', 'Team lead', 'All team leads'],
];
const CLEARS = { department: ['clientId', 'requirementId', 'recruiter', 'tl'], clientId: ['requirementId'], tl: ['recruiter'] };
const IN = new Intl.NumberFormat('en-IN');
const n0 = (v) => IN.format(Number(v) || 0);
const pctText = (v) => `${Math.round((Number(v) || 0) * 10) / 10}%`;

function useStored(key, fallback, ok) {
  const [v, setV] = useState(() => {
    try { const raw = localStorage.getItem(key); const x = raw === null ? fallback : JSON.parse(raw); return ok(x) ? x : fallback; } catch { return fallback; }
  });
  const set = (x) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* not remembered */ } };
  return [v, set];
}

async function download(url, fallbackName) {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const cd = res.headers['content-disposition'] || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    return '';
  } catch (err) {
    const blob = err.response && err.response.data;
    if (blob && typeof blob.text === 'function') { try { return JSON.parse(await blob.text()).error || 'The download did not work.'; } catch { /* not JSON */ } }
    return 'The download did not work. Please try again.';
  }
}

function barLabel(c, group) {
  if (group === 'month') { const [y, m] = c.key.split('-'); return `${shortDay(`${y}-${m}-01`).split(' ')[1]} ${y.slice(2)}`; }
  return shortDay(c.key);
}

export default function CandidateSources({ embedded = false, user }) {
  const navigate = useNavigate();
  const uid = (user && user.id) || 'anon';
  const [period, setPeriod] = useStored(`tl.sources.period.${uid}`, 'all', (x) => PERIODS.some(([k]) => k === x));
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [group, setGroup] = useStored(`tl.sources.group.${uid}`, 'auto', (x) => ['auto', 'day', 'week', 'month'].includes(x));
  const [onlyReal, setOnlyReal] = useStored(`tl.sources.real.${uid}`, false, (x) => typeof x === 'boolean');
  const [view, setView] = useStored(`tl.sources.view.${uid}`, 'table', (x) => ['table', 'chart'].includes(x));
  const [filters, setFilters] = useState({});
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showInside, setShowInside] = useState(false);
  const seq = useRef(0);

  const params = useMemo(() => {
    const p = { ...filters, period };
    if (period === 'custom' && custom.from && custom.to) { p.from = custom.from; p.to = custom.to; }
    if (group !== 'auto') p.group = group;
    if (onlyReal) p.onlyReal = '1';
    return p;
  }, [filters, period, custom, group, onlyReal]);
  const key = JSON.stringify(params);

  const load = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    api.get('/candidates/sources', { params })
      .then((r) => { if (mine === seq.current) { setData(r.data); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError((e.response && e.response.data && e.response.data.error) || 'Could not load the numbers. Please try again.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (period === 'custom' && !(custom.from && custom.to)) return; load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (k, v) => setFilters((f) => {
    const next = { ...f, [k]: v };
    if (!v) delete next[k];
    (CLEARS[k] || []).forEach((x) => { if (v) delete next[x]; });
    return next;
  });

  // One click on a number opens the People list with the same filters (the list's own filter).
  function openList({ source, from, to, kind } = {}) {
    const p = new URLSearchParams({ view: 'master', sub: 'all' });
    const d = (data && data.drill) || {};
    Object.entries(d).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (source) p.set('source', source);
    if (from) p.set('cameFrom', from);
    if (to) p.set('cameTo', to);
    if (kind) p.set('cameKind', kind);
    navigate(`/candidates?${p.toString()}`);
  }
  const periodRange = data && data.period && data.period.key !== 'all' ? { from: data.period.from, to: data.period.to } : {};
  const openCell = (r, which) => {
    const src = r.source === '*' ? undefined : r.source;
    if (which === 'people') return openList({ source: src, ...periodRange });
    const rg = data.ranges[which];
    return openList({ source: src, from: rg.from, to: rg.to });
  };

  async function exportTable(table, format) {
    setBusy(`${table}:${format}`);
    const q = new URLSearchParams({ ...params, table, format }).toString();
    const msg = await download(`/candidates/sources/export?${q}`, `candidate-sources.${format}`);
    setBusy('');
    if (msg) setError(msg);
  }

  const d = data;
  const rows = (d && d.rows) || [];
  const total = d && d.total;
  const empty = d && d.tiles.total === 0;
  const importedPeople = d ? d.total.importedPeople : 0;

  // ---- charts ----
  const sourceBars = rows.filter((r) => r.people > 0).map((r) => ({
    label: r.label, value: r.people, tone: r.source === IMPORTED_SOURCE ? 'grey' : undefined, onClick: () => openCell(r, 'people'),
  }));
  const seriesBars = d ? d.series.map((s) => ({
    label: barLabel(s, d.group),
    value: s.people,
    tone: s.people > 0 && s.imported === s.people ? 'grey' : undefined,
    onClick: s.people > 0 ? () => openList({ from: s.from, to: s.to }) : undefined,
  })) : [];
  const importedInSeries = d ? d.series.reduce((x, s) => x + s.imported, 0) : 0;

  return (
    <div className={`csrc${embedded ? ' is-embedded' : ''}`}>
      <div className="csrc-intro">
        <h2>Where candidates come from</h2>
        <p>How many people came from each source, and when they came. Click any blue number to see those people.</p>
        {d && d.scope && <p className="csrc-scope">{d.scope}</p>}
      </div>

      {/* Period: Today ... All time ... Custom */}
      <div className="csrc-period" role="group" aria-label="Period">
        {PERIODS.map(([k, label]) => (
          <button key={k} type="button" className={`csrc-pill${period === k ? ' is-on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{label}</button>
        ))}
        {period === 'custom' && (
          <span className="csrc-custom">
            <label>From <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label>To <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </span>
        )}
      </div>

      {/* Filters: each one narrows the others (with counts) */}
      {d && (
        <div className="csrc-filters">
          {FILTER_DEFS.map(([k, label, all]) => (
            <FacetSelect key={k} label={label} value={filters[k] || ''} onChange={(v) => setFilter(k, v)} options={(d.facets && d.facets[k]) || []} allLabel={all} loading={loading} />
          ))}
          <label className="csrc-check" title="People loaded by a big import only have the import day as their date. Tick to leave them out.">
            <input type="checkbox" checked={onlyReal} onChange={(e) => setOnlyReal(e.target.checked)} />
            Leave out people loaded by an import
          </label>
          {Object.keys(filters).length > 0 && <button type="button" className="btn btn-sm" onClick={() => setFilters({})}>Clear filters</button>}
        </div>
      )}

      {error && <div className="notice red csrc-err">{error} <button type="button" className="btn btn-sm" onClick={load}>Try again</button></div>}
      {!d && !error && <div className="small-muted csrc-loading">Counting the candidates…</div>}

      {d && (
        <div className={`csrc-body${loading ? ' is-loading' : ''}`}>
          <div className="csrc-period-label">{d.period.label}{loading ? ' · updating…' : ''}</div>

          {/* The four big tiles */}
          <div className="csrc-tiles">
            <StatCard
              label="Total candidates"
              value={d.tiles.total}
              zeroText="Nobody in this period"
              tone="blue"
              help="Every person who came in this period, from any source."
              onClick={d.tiles.total ? () => openList(periodRange) : undefined}
              title="Show these people"
            />
            <StatCard
              label="Sources"
              value={d.tiles.sources}
              zeroText="No source written down yet"
              help="How many different places people came from. People with no source written down are not counted as a source."
              hint={d.tiles.sources ? undefined : 'Pick a source when you add a candidate.'}
            />
            <StatCard
              label="Best source"
              value={d.tiles.best ? d.tiles.best.source : null}
              zeroText="None yet"
              tone="green"
              help="The place most people came from (not counting people with no source written down)."
              hint={d.tiles.best ? `${n0(d.tiles.best.people)} people` : undefined}
              onClick={d.tiles.best ? () => openList({ source: d.tiles.best.source, ...periodRange }) : undefined}
              title="Show these people"
            />
            <StatCard
              label="New today"
              value={d.tiles.today}
              zeroText="Nobody new today"
              tone="yellow"
              help="People who came today, from any source."
              hint={d.tiles.todayImported ? `${n0(d.tiles.todayImported)} of them loaded by an import` : undefined}
              onClick={d.tiles.today ? () => openList({ from: d.today, to: d.today }) : undefined}
              title="Show these people"
            />
          </div>

          <Quality q={d.quality} onShow={openList} />

          {empty ? (
            <EmptyState
              icon="🧲"
              title="Nobody came in this period."
              hint={period === 'all' ? 'Try removing a filter.' : 'Try a longer period, or All time.'}
              action={period !== 'all' ? <button type="button" className="btn btn-sm" onClick={() => setPeriod('all')}>Show all time</button> : null}
            />
          ) : (
            <>
              <div className="csrc-bar">
                <span className="csrc-seg" role="group" aria-label="How to show it">
                  <button type="button" className={view === 'table' ? 'is-on' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
                  <button type="button" className={view === 'chart' ? 'is-on' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
                </span>
                <span className="csrc-bar-note small-muted">{importedPeople > 0 ? `${n0(importedPeople)} of ${n0(total.people)} were loaded by an import — their date is the import day.` : ''}</span>
              </div>

              {view === 'table' ? (
                <section className="csrc-card" aria-label="People by source">
                  <div className="csrc-card-head">
                    <h3>Who came from where</h3>
                    {d.can.export && <ExportButtons busy={busy.startsWith('sources:') ? busy.split(':')[1] : ''} onPick={(f) => exportTable('sources', f)} />}
                  </div>
                  <SourceTable rows={rows} total={total} onOpen={openCell} d={d} />
                  <MobileCards rows={rows} total={total} onOpen={openCell} />
                  {d.inside.length > 0 && rows.some((r) => r.source === IMPORTED_SOURCE) && (
                    <div className="csrc-inside">
                      <button type="button" className="csrc-link" aria-expanded={showInside} onClick={() => setShowInside((x) => !x)}>
                        {showInside ? 'Hide' : `What is inside "${NOT_RECORDED}"?`}
                      </button>
                      {showInside && (
                        <>
                          <p className="small-muted">These people have no source written down. The words below are the names of the old sheets they were loaded from, not places they came from.</p>
                          <ul className="csrc-inside-list">
                            {d.inside.map((x) => <li key={x.word}><span>{x.word}</span><b>{n0(x.people)}</b></li>)}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <div className="csrc-charts">
                  <ChartCard
                    title="People by source"
                    sub="Click a bar to see those people. Grey = no source written down."
                    isEmpty={!sourceBars.length}
                    table={<DataTable headers={['Source', 'People', 'Share']} rows={rows.map((r) => [r.label, n0(r.people), pctText(r.share)])} numeric={[1, 2]} />}
                  >
                    <BarChart horizontal data={sourceBars} title="People by source" valueFormat={(v) => `${n0(v)} people`} />
                  </ChartCard>
                  <ChartCard
                    title="When they came"
                    sub={`${d.group === 'day' ? 'Each bar is one day.' : d.group === 'week' ? 'Each bar is one week, starting on the Monday shown.' : 'Each bar is one month.'}${importedInSeries ? ' Grey = people loaded by an import (their date is the import day).' : ''}`}
                    isEmpty={!seriesBars.some((x) => x.value > 0)}
                    table={<DataTable headers={['When', 'People', 'Of them loaded by an import']} rows={d.series.map((s) => [s.label, n0(s.people), n0(s.imported)])} numeric={[1, 2]} />}
                  >
                    {seriesBars.length > 24
                      ? <LineChart points={seriesBars} title="When they came" valueFormat={(v) => `${n0(v)} people`} />
                      : <BarChart data={seriesBars} title="When they came" valueFormat={(v) => `${n0(v)} people`} />}
                  </ChartCard>
                </div>
              )}

              {/* When they came: grouping + the over-time table */}
              <section className="csrc-card" aria-label="Source over time">
                <div className="csrc-card-head">
                  <h3>Source over time</h3>
                  <span className="csrc-seg" role="group" aria-label="Group by">
                    {GROUPS.map(([k, label]) => (
                      <button key={k} type="button" className={d.group === k ? 'is-on' : ''} aria-pressed={d.group === k} onClick={() => setGroup(k)}>{label}</button>
                    ))}
                  </span>
                  {d.can.export && <ExportButtons busy={busy.startsWith('overtime:') ? busy.split(':')[1] : ''} onPick={(f) => exportTable('overtime', f)} />}
                </div>
                {d.groupNote && <div className="small-muted csrc-note">{d.groupNote}</div>}
                <OverTime d={d} />
              </section>
            </>
          )}

          {d.can.cleanup && <Cleanup onApplied={load} />}
        </div>
      )}
    </div>
  );
}

// ---- data quality: honest, with a button to see the people ----
function Quality({ q, onShow }) {
  const [open, setOpen] = useState(false);
  if (!q || !q.people) return null;
  const k = q.kinds || {};
  return (
    <div className="csrc-quality">
      {q.noSource > 0 && (
        <div className="csrc-q-line is-orange">
          <span><b>{n0(q.noSource)}</b> {q.noSource === 1 ? 'person has' : 'people have'} no source recorded ({pctText(q.noSourcePct)}).</span>
          <button type="button" className="btn btn-sm" onClick={() => onShow({ source: IMPORTED_SOURCE })}>Show them</button>
        </div>
      )}
      {q.importedDate > 0 && (
        <div className="csrc-q-line is-orange">
          <span><b>{n0(q.importedDate)}</b> {q.importedDate === 1 ? 'person has' : 'people have'} only an import date ({pctText(q.importedDatePct)}) — the day the profile was loaded, not the day they really arrived.</span>
          <button type="button" className="btn btn-sm" onClick={() => onShow({ kind: 'imported' })}>Show them</button>
        </div>
      )}
      <button type="button" className="csrc-link" aria-expanded={open} onClick={() => setOpen((x) => !x)}>What does “came on” mean?</button>
      {open && (
        <ul className="csrc-means">
          <li><b>{n0(k.sheet)}</b> — {q.meaning.sheet}</li>
          <li><b>{n0(k.applied)}</b> — {q.meaning.applied}</li>
          <li><b>{n0(k.entered)}</b> — {q.meaning.entered}</li>
          <li><b>{n0(k.imported)}</b> — {q.meaning.imported}</li>
        </ul>
      )}
    </div>
  );
}

function When({ day, importedOnly }) {
  if (!day) return <span className="small-muted">—</span>;
  return <span title={importedOnly ? `Imported on ${longDay(day)} (not the real arrival day)` : longDay(day)}>{shortDay(day)}{importedOnly ? ' (import)' : ''}</span>;
}
const Num = ({ v, onClick, label }) => (v > 0
  ? <button type="button" className="csrc-num" onClick={onClick} title={`Show these people: ${label}`}>{n0(v)}</button>
  : <span className="small-muted">—</span>);

function SourceTable({ rows, total, onOpen, d }) {
  return (
    <div className="csrc-tablewrap">
      <table className="csrc-table">
        <thead>
          <tr>
            <th>Source</th><th className="r">People</th><th>Share</th><th>First came</th><th>Last came</th>
            <th className="r">Today</th><th className="r">This week</th><th className="r">This month</th>
            <th className="r" title="Sent to the client at some point">Sent to client</th><th className="r">Interview</th><th className="r">Joined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className={r.source === IMPORTED_SOURCE ? 'is-grey' : ''}>
              <td className="csrc-src"><b>{r.label}</b>{r.source === IMPORTED_SOURCE && <span className="small-muted"> old imports</span>}</td>
              <td className="r"><Num v={r.people} onClick={() => onOpen(r, 'people')} label={r.label} /></td>
              <td><span className="csrc-share"><i style={{ width: `${Math.max(2, Math.min(100, r.share))}%` }} /></span><span className="csrc-pct">{pctText(r.share)}</span></td>
              <td><When day={r.first} importedOnly={r.imported} /></td>
              <td><When day={r.last} importedOnly={r.imported} /></td>
              <td className="r"><Num v={r.today} onClick={() => onOpen(r, 'today')} label={`${r.label}, today`} /></td>
              <td className="r"><Num v={r.week} onClick={() => onOpen(r, 'week')} label={`${r.label}, this week`} /></td>
              <td className="r"><Num v={r.month} onClick={() => onOpen(r, 'month')} label={`${r.label}, this month`} /></td>
              <td className="r">{r.people ? <>{n0(r.sent)} <span className="small-muted">({pctText(r.sentPct)})</span></> : '—'}</td>
              <td className="r">{r.people ? <>{n0(r.interview)} <span className="small-muted">({pctText(r.interviewPct)})</span></> : '—'}</td>
              <td className="r">{r.people ? <>{n0(r.joined)} <span className="small-muted">({pctText(r.joinedPct)})</span></> : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td><b>Total</b></td>
            <td className="r"><b>{n0(total.people)}</b></td>
            <td>{total.people ? '100%' : ''}</td>
            <td><When day={total.first} /></td>
            <td><When day={total.last} /></td>
            <td className="r">{n0(total.today)}</td>
            <td className="r">{n0(total.week)}</td>
            <td className="r">{n0(total.month)}</td>
            <td className="r">{n0(total.sent)} <span className="small-muted">({pctText(total.sentPct)})</span></td>
            <td className="r">{n0(total.interview)} <span className="small-muted">({pctText(total.interviewPct)})</span></td>
            <td className="r">{n0(total.joined)} <span className="small-muted">({pctText(total.joinedPct)})</span></td>
          </tr>
        </tfoot>
      </table>
      <p className="small-muted csrc-foot">“Sent to client”, “Interview” and “Joined” count people who ever reached that step, as a share of the people from that source. {d && d.period.label}</p>
    </div>
  );
}

// On a phone the table becomes one card per source.
function MobileCards({ rows, total, onOpen }) {
  return (
    <div className="csrc-cards">
      {rows.map((r) => (
        <div key={r.source} className={`csrc-mcard${r.source === IMPORTED_SOURCE ? ' is-grey' : ''}`}>
          <div className="csrc-mcard-top">
            <b>{r.label}</b>
            <button type="button" className="csrc-num big" disabled={!r.people} onClick={() => onOpen(r, 'people')}>{n0(r.people)}<small> people</small></button>
          </div>
          <div className="csrc-share"><i style={{ width: `${Math.max(2, Math.min(100, r.share))}%` }} /></div>
          <div className="small-muted">{pctText(r.share)} of everyone · first came <When day={r.first} importedOnly={r.imported} /> · last came <When day={r.last} importedOnly={r.imported} /></div>
          <dl className="csrc-facts">
            <div><dt>Today</dt><dd>{n0(r.today)}</dd></div>
            <div><dt>This week</dt><dd>{n0(r.week)}</dd></div>
            <div><dt>This month</dt><dd>{n0(r.month)}</dd></div>
            <div><dt>Sent to client</dt><dd>{n0(r.sent)}</dd></div>
            <div><dt>Interview</dt><dd>{n0(r.interview)}</dd></div>
            <div><dt>Joined</dt><dd>{n0(r.joined)}</dd></div>
          </dl>
        </div>
      ))}
      <div className="csrc-mcard is-total"><b>Total</b><span>{n0(total.people)} people · {n0(total.joined)} joined</span></div>
    </div>
  );
}

function OverTime({ d }) {
  const o = d.overTime;
  if (!o.rows.length) return <div className="small-muted csrc-note">Nobody came in this period.</div>;
  return (
    <>
      <div className="csrc-tablewrap csrc-over-desktop">
        <table className="csrc-table csrc-over">
          <thead>
            <tr>
              <th className="csrc-sticky">Source</th>
              {o.columns.map((c) => <th key={c.key} className="r" title={`${longDay(c.from)}${c.from !== c.to ? ` to ${longDay(c.to)}` : ''}`}>{c.label}</th>)}
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {o.rows.map((r) => (
              <tr key={r.source} className={r.source === IMPORTED_SOURCE ? 'is-grey' : ''}>
                <td className="csrc-sticky"><b>{r.label}</b></td>
                {r.values.map((v, i) => <td key={o.columns[i].key} className="r">{v ? n0(v) : <span className="small-muted">·</span>}</td>)}
                <td className="r"><b>{n0(r.total)}</b></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="csrc-sticky"><b>Total</b></td>
              {o.totals.map((v, i) => <td key={o.columns[i].key} className="r">{n0(v)}</td>)}
              <td className="r"><b>{n0(o.total)}</b></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {/* On a phone: one card per source, the busiest columns as small chips */}
      <div className="csrc-cards csrc-over-mobile">
        {o.rows.map((r) => (
          <div key={r.source} className={`csrc-mcard${r.source === IMPORTED_SOURCE ? ' is-grey' : ''}`}>
            <div className="csrc-mcard-top"><b>{r.label}</b><span>{n0(r.total)} in all</span></div>
            <div className="csrc-chips">
              {r.values.map((v, i) => (v ? <span key={o.columns[i].key} className="csrc-chip"><small>{o.columns[i].label}</small><b>{n0(v)}</b></span> : null))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- Admin: tidy the source words (preview, confirm, undo) ----
function Cleanup({ onApplied }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [prev, setPrev] = useState(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const loadList = () => api.get('/candidates/sources/cleanup').then((r) => { setList(r.data); setErr(''); }).catch((e) => setErr((e.response && e.response.data && e.response.data.error) || 'Could not load the suggestions.'));
  useEffect(() => { if (open && !list) loadList(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function preview(g) {
    setErr(''); setSure(false);
    try { const r = await api.post('/candidates/sources/cleanup/preview', { target: g.target }); setPrev({ ...r.data, group: g }); } catch (e) { setErr((e.response && e.response.data && e.response.data.error) || 'Could not preview.'); }
  }
  async function apply() {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/candidates/sources/cleanup/apply', { target: prev.target, confirm: true });
      setDone(r.data); setPrev(null); loadList(); onApplied();
    } catch (e) { setErr((e.response && e.response.data && e.response.data.error) || 'That did not work. Nothing was changed.'); } finally { setBusy(false); }
  }
  async function undo() {
    setBusy(true);
    try { await api.post('/candidates/sources/cleanup/undo', { undoId: done.undoId, confirm: true }); setDone({ ok: true, undone: true, message: 'Put back as it was.' }); loadList(); onApplied(); } catch (e) { setErr((e.response && e.response.data && e.response.data.error) || 'Could not undo.'); } finally { setBusy(false); }
  }

  return (
    <section className="csrc-card csrc-clean" aria-label="Tidy the source words">
      <button type="button" className="csrc-link big" aria-expanded={open} onClick={() => setOpen((x) => !x)}>{open ? '▼' : '▶'} Tidy the source words (Admin)</button>
      {open && (
        <>
          <p className="small-muted">Different spellings of one place (for example “Naukri”, “naukri.com”) can be joined into one. Look at the preview first. The old word is kept and you can undo.</p>
          {err && <div className="notice red">{err}</div>}
          {done && <div className="notice green">{done.message} {done.undoId && !done.undone && <button type="button" className="btn btn-sm" disabled={busy} onClick={undo}>Undo this</button>}</div>}
          {!list && !err && <div className="small-muted">Looking…</div>}
          {list && list.groups.length === 0 && <EmptyState compact icon="✅" title="Every source word is already tidy." />}
          {list && list.groups.map((g) => (
            <div key={g.target} className="csrc-group">
              <div className="csrc-group-head">
                <span><b>{sourceLabel(g.target)}</b> <span className="small-muted">{g.kind === 'sheet' ? 'old sheet names and notes, not real sources' : 'same place, written in different ways'}</span></span>
                <span>{n0(g.people)} people · {g.words.length} {g.words.length === 1 ? 'word' : 'words'}</span>
                <button type="button" className="btn btn-sm" onClick={() => preview(g)}>Preview merge</button>
              </div>
              <div className="small-muted csrc-words">{g.words.slice(0, 6).map((w) => `${w.word} (${n0(w.people)})`).join(' · ')}{g.words.length > 6 ? ` · and ${g.words.length - 6} more` : ''}</div>
            </div>
          ))}
        </>
      )}
      {prev && (
        <Modal
          title={`Join into “${sourceLabel(prev.target)}”?`}
          onClose={() => setPrev(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setPrev(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !sure || !prev.people} onClick={apply}>{busy ? 'Working…' : `Join ${n0(prev.people)} people`}</button>
            </>
          )}
        >
          <p><b>{n0(prev.people)}</b> people and <b>{n0(prev.applications)}</b> requirement applications will say “{sourceLabel(prev.target)}”.</p>
          <ul className="csrc-inside-list">{prev.words.slice(0, 12).map((w) => <li key={w.word}><span>{w.word}</span><b>{n0(w.people)}</b></li>)}</ul>
          {prev.words.length > 12 && <p className="small-muted">and {prev.words.length - 12} more words</p>}
          {prev.sample.length > 0 && <p className="small-muted">For example: {prev.sample.slice(0, 4).map((s) => `${s.name} (was “${s.was}”)`).join(', ')}.</p>}
          <p className="small-muted">{prev.note}</p>
          <label className="csrc-check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I looked at the preview and want to join these.</label>
        </Modal>
      )}
    </section>
  );
}
