import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import FollowUpImportButton from './FollowUpImport.jsx';
import '../clients/followUpLog.css';
import './followUpReport.css';

// THE FOLLOW-UP REPORT (founder 2026-11-20): "a TL has several recruiters under them ... check all those recruiters' daily, weekly and
// monthly follow-up reports at once, in one place". On the ATS Follow-ups page, tab "Follow-up report".
//   A TL sees one row per recruiter of their team (+ Totals); a recruiter sees only their own numbers and follow-ups; a Manager / Admin /
//   STL picks a team lead, department or team. The server (routes/followUpReport.js, utils/followUpScope.js) decides who is in the
//   picture - this screen only draws what it is sent, and never asks for anybody else.
const DAY = 86400000;
const plus = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monday = (ymd) => plus(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd) => { const d = new Date(`${monthStart(ymd)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return plus(d.toISOString().slice(0, 10), -1); };
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const PERIODS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
function presetsFor(today) {
  const wk = monday(today);
  const lastMonthEnd = plus(monthStart(today), -1);
  return [
    ['today', 'Today', today, today],
    ['yesterday', 'Yesterday', plus(today, -1), plus(today, -1)],
    ['thisweek', 'This week', wk, plus(wk, 6)],
    ['lastweek', 'Last week', plus(wk, -7), plus(wk, -1)],
    ['thismonth', 'This month', monthStart(today), monthEnd(today)],
    ['lastmonth', 'Last month', monthStart(lastMonthEnd), lastMonthEnd],
  ];
}
const STATUS_CLASS = { Overdue: 'fur-bad', 'Done late': 'fur-warn', Done: 'fur-ok', 'Due today': 'fur-warn' };

// one sortable column header
function Th({ id, label, title, sort, setSort, num }) {
  const on = sort.key === id;
  return (
    <th className={num ? 'fur-num' : ''} title={title} aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="fur-sort" onClick={() => setSort({ key: id, dir: on ? -sort.dir : (num ? -1 : 1) })}>
        {label}<span aria-hidden="true">{on ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );
}
const sorter = (sort, get) => (a, b) => {
  const x = get(a, sort.key); const y = get(b, sort.key);
  const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''));
  return r * sort.dir || String(a.name).localeCompare(String(b.name));
};
// the little bar chart of a person's days (added + done + logged per column)
function Trend({ values }) {
  const max = Math.max(1, ...values);
  return (
    <span className="fur-trend" aria-hidden="true">
      {values.slice(0, 62).map((v, i) => <i key={i} style={{ height: `${Math.max(v ? 14 : 2, (v / max) * 100)}%` }} className={v ? '' : 'z'} />)}
    </span>
  );
}

export default function FollowUpReport({ home = false }) {
  const [opts, setOpts] = useState(null);
  const [period, setPeriod] = useState(home ? 'day' : 'week');
  const [range, setRange] = useState({ from: '', to: '' });
  const [preset, setPreset] = useState(home ? 'today' : 'thisweek');
  const [pick, setPick] = useState({ leadId: '', department: '', team: '' });
  const [imported, setImported] = useState('include');
  const [columns, setColumns] = useState(''); // '' = the usual for the period; day | week | month
  const [view, setView] = useState('who');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'activity', dir: -1 });
  const [mSort, setMSort] = useState({ key: 'total', dir: -1 });
  const [personId, setPersonId] = useState('');
  const [who, setWho] = useState(null); // the drill-down: one person's day-by-day table
  const [lf, setLf] = useState({ q: '', personId: '', status: '', outcome: '' });
  const [list, setList] = useState(null);
  const [limit, setLimit] = useState(200);
  const [reload, setReload] = useState(0); // an import or an undo loads the report again

  useEffect(() => {
    api.get('/followup-report/options').then((r) => {
      setOpts(r.data);
      const p = presetsFor(r.data.today).find((x) => x[0] === (home ? 'today' : 'thisweek'));
      setRange({ from: p[2], to: p[3] });
    }).catch((e) => setError(e.response?.data?.error || 'The follow-up report could not be opened.'));
  }, []);

  const base = useMemo(() => ({ from: range.from || undefined, to: range.to || undefined, period, columns: columns || undefined, imported, leadId: pick.leadId || undefined, department: pick.department || undefined, team: pick.team || undefined }), [range, period, columns, imported, pick]);

  useEffect(() => {
    if (!opts || !range.from) return;
    setLoading(true);
    api.get('/followup-report/summary', { params: base })
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'The report could not be loaded.'); })
      .finally(() => setLoading(false));
  }, [opts, base, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // the drill-down of one person, and the list (the whole team's, or the filters')
  useEffect(() => {
    if (!data || !personId) { setWho(null); return; }
    api.get('/followup-report/person', { params: { ...base, personId } }).then((r) => setWho(r.data)).catch(() => setWho(null));
  }, [data, personId]); // eslint-disable-line react-hooks/exhaustive-deps
  const listParams = useMemo(() => ({
    ...base,
    ...(personId && view !== 'list' ? { personId } : {}),
    ...(view === 'list' && lf.personId ? { personId: lf.personId } : {}),
    q: lf.q || undefined, status: lf.status || undefined, outcome: lf.outcome || undefined, limit,
  }), [base, personId, view, lf, limit]);
  useEffect(() => {
    if (!data || (view !== 'list' && !personId)) return undefined;
    const t = setTimeout(() => {
      api.get('/followup-report/list', { params: listParams }).then((r) => setList(r.data)).catch(() => setList(null));
    }, lf.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [data, view, personId, listParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = opts ? opts.today : '';
  const mine = !!data && data.mode === 'mine';
  const showLead = !!data && data.table.headers.includes('TL');
  const chooseRange = (key, from, to) => { setPreset(key); setRange({ from, to }); setPersonId(''); setLimit(200); };
  const choosePeriod = (p) => {
    setPeriod(p); setColumns('');
    const k = p === 'day' ? 'today' : p === 'week' ? 'thisweek' : 'thismonth';
    const x = presetsFor(today).find((y) => y[0] === k);
    chooseRange(k, x[2], x[3]);
  };

  const FIELDS = data ? data.fields : [];
  const rows = useMemo(() => {
    if (!data) return [];
    const get = (r, k) => (k === 'name' ? r.name : k === 'lead' ? (r.leadName || '') : k === 'activity' ? r.activity : r.m[data.fields.indexOf(k)]);
    return [...data.rows].sort(sorter(sort, get));
  }, [data, sort]);
  const matrixRows = useMemo(() => {
    if (!data) return [];
    const get = (r, k) => (k === 'name' ? r.name : k === 'total' ? r.activity : r.trend[Number(k)] || 0);
    return [...data.rows].sort(sorter(mSort, get));
  }, [data, mSort]);
  const mMax = useMemo(() => Math.max(1, ...(data ? data.rows.flatMap((r) => r.trend) : [1])), [data]);

  if (error && !data) return home ? null : <div className="card section"><div className="error-text">{error}</div></div>;
  if (!opts || !data) return home ? null : <div className="card section small-muted">Loading the follow-up report…</div>;

  const exportParams = { ...listParams, limit: undefined, personId: view === 'list' ? (lf.personId || undefined) : (personId || undefined) };
  const t = data.total;
  const drill = who && who.person;
  const g = data.granularity;

  return (
    <div className="card section fur">
      <div className="fur-head">
        <div>
          <h3 style={{ margin: 0 }}>{mine ? (home ? 'My daily report' : 'My follow-up report') : (home ? 'Daily report of your team' : 'Follow-up report')}</h3>
          <div className="small-muted">
            {mine ? 'Your own follow-ups, calls and call-backs, day by day. Nobody else\'s numbers are shown here.'
              : `${data.label}: one row for each person, with the totals. Click a row to see that person day by day and every follow-up they did.`}
          </div>
        </div>
        <div className="fur-io">
          <FollowUpImportButton onDone={() => setReload((v) => v + 1)} />
          <ExportMenu url="/followup-report/export" formats={['xlsx', 'csv']} label="Download Excel" params={exportParams} note="The table, the day-by-day table and every follow-up of these filters" />
        </div>
      </div>

      <div className="fur-bar">
        <div className="fur-seg" role="tablist" aria-label="Day, week or month">
          {PERIODS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={period === k} className={`btn btn-sm${period === k ? ' btn-primary' : ''}`} onClick={() => choosePeriod(k)}>{l}</button>)}
        </div>
        <div className="fur-presets">
          {presetsFor(today).map(([k, l, f, to]) => <button key={k} type="button" className={`btn btn-sm${preset === k ? ' btn-primary' : ''}`} onClick={() => chooseRange(k, f, to)}>{l}</button>)}
        </div>
        <label className="small-muted">From <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); }} /></label>
        <label className="small-muted">To <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); }} /></label>
        {!mine && data.leads && (
          <select value={pick.leadId} onChange={(e) => { setPick({ ...pick, leadId: e.target.value }); setPersonId(''); }} aria-label="Team lead">
            <option value="">All team leads</option>
            {data.leads.map((l) => <option key={l.id} value={l.id}>{`${l.name} (${l.count})`}</option>)}
          </select>
        )}
        {!mine && data.departments && data.departments.length > 1 && (
          <select value={pick.department} onChange={(e) => { setPick({ ...pick, department: e.target.value }); setPersonId(''); }} aria-label="Department">
            <option value="">All departments</option>
            {data.departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {!mine && data.teams && data.teams.length > 1 && (
          <select value={pick.team} onChange={(e) => { setPick({ ...pick, team: e.target.value }); setPersonId(''); }} aria-label="Team">
            <option value="">All teams</option>
            {data.teams.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <select value={columns || data.columns} onChange={(e) => setColumns(e.target.value)} aria-label="Columns of the table" title="The columns of the day-by-day table">
          <option value="day">Columns: days</option>
          <option value="week">Columns: weeks</option>
          <option value="month">Columns: months</option>
        </select>
        <select value={imported} onChange={(e) => setImported(e.target.value)} aria-label="Imported follow-ups" title="Follow-ups brought in from the old sheets are counted on their own date">
          <option value="include">With imported</option>
          <option value="exclude">Without imported</option>
          <option value="only">Only imported</option>
        </select>
        <span className="small-muted">{`${fmtDay(data.from)}${data.from === data.to ? '' : ` to ${fmtDay(data.to)}`}`}{loading ? ' · loading…' : ''}</span>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="fur-tabs" role="tablist" aria-label="Report views">
        <button type="button" role="tab" aria-selected={view === 'who'} className={`flog-tab${view === 'who' ? ' on' : ''}`} onClick={() => setView('who')}>{mine ? 'My numbers' : 'By recruiter'}</button>
        <button type="button" role="tab" aria-selected={view === 'days'} className={`flog-tab${view === 'days' ? ' on' : ''}`} onClick={() => setView('days')}>{`${g.charAt(0).toUpperCase()}${g.slice(1)} by ${g}`}</button>
        <button type="button" role="tab" aria-selected={view === 'list'} className={`flog-tab${view === 'list' ? ' on' : ''}`} onClick={() => setView('list')}>{mine ? 'My follow-ups' : 'Whole team list'}</button>
      </div>

      {view === 'who' && (
        <div className="fur-wrap">
          <table className="fur-table">
            <thead>
              <tr>
                <Th id="name" label={mine ? 'You' : 'Recruiter'} sort={sort} setSort={setSort} />
                {showLead && <Th id="lead" label="TL" sort={sort} setSort={setSort} />}
                {FIELDS.map((f, i) => <Th key={f} id={f} num label={data.labels[i]} title={data.help[i]} sort={sort} setSort={setSort} />)}
                <Th id="activity" num label="Trend" title="Follow-ups added + done + logged in each column of the day-by-day table" sort={sort} setSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`${mine ? '' : 'fur-click'}${personId === r.id ? ' on' : ''}`} onClick={() => !mine && setPersonId(personId === r.id ? '' : r.id)} title={mine ? undefined : 'Click to see this person day by day and every follow-up'}>
                  <td><b>{r.name}</b>{r.former && <span className="fur-tag">left</span>}{r.role && !mine ? <span className="small-muted">{` · ${r.role}`}</span> : null}</td>
                  {showLead && <td>{r.leadName || ''}</td>}
                  {r.m.map((v, i) => <td key={FIELDS[i]} className={`fur-num${v ? '' : ' fur-zero'}${FIELDS[i] === 'overdue' && v ? ' fur-bad' : ''}`}>{v || '–'}</td>)}
                  <td className="fur-num"><Trend values={r.trend} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={FIELDS.length + 3} className="small-muted">No follow-up in these days.</td></tr>}
            </tbody>
            {!mine && (
              <tfoot>
                <tr><td><b>Total</b></td>{showLead && <td />}{t.m.map((v, i) => <td key={FIELDS[i]} className="fur-num"><b>{v || '–'}</b></td>)}<td className="fur-num"><Trend values={t.trend} /></td></tr>
              </tfoot>
            )}
          </table>
          <div className="small-muted fur-note">
            Everything is counted on the day it was done (IST). A follow-up done by someone who has since left stays with them. Hover a heading to see what it counts.
            {data.imported > 0 ? ` ${data.imported} imported follow-ups from the old sheets are counted on their own dates.` : ''}
          </div>
        </div>
      )}

      {view === 'days' && (
        <div className="fur-wrap">
          <div className="small-muted fur-note">{`Follow-ups added + done + logged, ${g} by ${g}. Click any heading to sort: who followed up how much.`}</div>
          <table className="fur-table fur-matrix">
            <thead>
              <tr>
                <Th id="name" label={mine ? 'You' : 'Recruiter'} sort={mSort} setSort={setMSort} />
                {data.buckets.map((b, i) => <Th key={b.from} id={String(i)} num label={b.label} title={b.long} sort={mSort} setSort={setMSort} />)}
                <Th id="total" num label="Total" sort={mSort} setSort={setMSort} />
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((r) => (
                <tr key={r.id} className={mine ? '' : 'fur-click'} onClick={() => { if (!mine) { setPersonId(r.id); setView('who'); } }}>
                  <td><b>{r.name}</b>{r.former && <span className="fur-tag">left</span>}</td>
                  {r.trend.map((v, i) => <td key={i} className="fur-num fur-cell" style={v ? { background: `rgba(31, 91, 216, ${0.08 + 0.42 * (v / mMax)})` } : undefined}>{v || '–'}</td>)}
                  <td className="fur-num"><b>{r.activity}</b></td>
                </tr>
              ))}
            </tbody>
            {!mine && <tfoot><tr><td><b>Total</b></td>{t.trend.map((v, i) => <td key={i} className="fur-num"><b>{v || '–'}</b></td>)}<td className="fur-num"><b>{t.activity}</b></td></tr></tfoot>}
          </table>
        </div>
      )}

      {(view === 'list' || (view === 'who' && personId)) && (
        <>
          {view === 'who' && drill && (
            <div className="fur-drill">
              <div className="fur-drill-head">
                <h4 style={{ margin: 0 }}>{`${who.person.name}${who.person.former ? ' (left)' : ''}`}<span className="small-muted">{who.person.leadName ? ` · TL ${who.person.leadName}` : ''}</span></h4>
                <button type="button" className="btn btn-sm" onClick={() => setPersonId('')}>Close</button>
              </div>
              <div className="fur-wrap">
                <table className="fur-table">
                  <thead><tr><th>{g.charAt(0).toUpperCase() + g.slice(1)}</th>{who.labels.map((l, i) => <th key={l} className="fur-num" title={who.help[i]}>{l}</th>)}</tr></thead>
                  <tbody>
                    {who.buckets.map((b, i) => <tr key={b.from}><td>{b.long || b.label}</td>{who.byBucket[i].map((v, j) => <td key={j} className={`fur-num${v ? '' : ' fur-zero'}`}>{v || '–'}</td>)}</tr>)}
                  </tbody>
                  <tfoot><tr><td><b>Whole period</b></td>{who.total.map((v, j) => <td key={j} className="fur-num"><b>{v || '–'}</b></td>)}</tr></tfoot>
                </table>
              </div>
            </div>
          )}
          {view === 'list' && (
            <div className="fur-filters">
              <input type="search" value={lf.q} placeholder="Search a candidate, requirement, client, name or what happened…" onChange={(e) => { setLf({ ...lf, q: e.target.value }); setLimit(200); }} />
              {!mine && (
                <select value={lf.personId} onChange={(e) => { setLf({ ...lf, personId: e.target.value }); setLimit(200); }} aria-label="Recruiter">
                  <option value="">Whole team</option>
                  {data.rows.map((r) => <option key={r.id} value={r.id}>{`${r.name}${r.former ? ' (left)' : ''}`}</option>)}
                </select>
              )}
              <select value={lf.status} onChange={(e) => setLf({ ...lf, status: e.target.value })} aria-label="Status">
                <option value="">Any status</option>
                {['Done', 'Done late', 'Overdue', 'Due today', 'Upcoming', 'Logged', 'Written', 'Open'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={lf.outcome} onChange={(e) => setLf({ ...lf, outcome: e.target.value })} aria-label="Answer">
                <option value="">Any answer</option>
                <option value="interested">Interested</option>
                <option value="notInterested">Not interested</option>
                <option value="noAnswer">No answer</option>
              </select>
            </div>
          )}
          <div className="fur-wrap">
            <table className="fur-table fur-list">
              <thead><tr><th>Date</th>{!mine && <th>Recruiter</th>}<th>Candidate / client</th><th>Requirement</th><th>What happened</th><th>Call back on</th><th>Answer</th><th>Status</th></tr></thead>
              <tbody>
                {list && list.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDay(r.day)}</td>
                    {!mine && <td>{r.byName}{r.byRole ? <span className="small-muted">{` · ${r.byRole}`}</span> : null}</td>}
                    <td>{r.link ? <Link to={r.link}>{r.candidateName || r.kind}</Link> : r.candidateName}<div className="small-muted">{r.type}</div></td>
                    <td>{r.requirement || ''}{r.client ? <div className="small-muted">{r.client}</div> : null}</td>
                    <td className="fur-what">{r.what}</td>
                    <td>{r.callBackDay ? fmtDay(r.callBackDay) : ''}</td>
                    <td>{r.outcome || ''}</td>
                    <td><span className={`fur-status ${STATUS_CLASS[r.status] || ''}`}>{r.status}</span>{r.carried && <span className="fur-tag">carried over</span>}{r.imported && <span className="fur-tag">imported</span>}</td>
                  </tr>
                ))}
                {list && list.rows.length === 0 && <tr><td colSpan={mine ? 7 : 8} className="small-muted">No follow-up matches.</td></tr>}
                {!list && <tr><td colSpan={mine ? 7 : 8} className="small-muted">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
          {list && <div className="small-muted">{`${list.rows.length} of ${list.total} follow-ups`}{list.total > list.rows.length && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setLimit((n) => n + 300)}>Show more</button>}</div>}
        </>
      )}
    </div>
  );
}
