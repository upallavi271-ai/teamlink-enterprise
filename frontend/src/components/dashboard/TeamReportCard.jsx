import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './teamReportCard.css';

// "REPORT OF YOUR TEAM" on the ATS dashboard (founder 2026-11-20): only for team leads. One small table, one row per recruiter, four numbers
// and a View button; View opens that recruiter's report in a side panel: the candidates they added and every follow-up with what was written.
// A Super Admin has no card; they get one button, "Overall report", that opens the same table for everybody.
// The server (/api/followup-report, utils/followUpScope.js) decides who is in the picture; this screen only draws what it is sent.
const DAY = 86400000;
const plus = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monday = (ymd) => plus(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const presetsFor = (today) => {
  const wk = monday(today);
  return [
    ['today', 'Today', today, today],
    ['yesterday', 'Yesterday', plus(today, -1), plus(today, -1)],
    ['thisweek', 'This week', wk, plus(wk, 6)],
    ['thismonth', 'This month', monthStart(today), today],
  ];
};
const SHOWN = [['added', 'Follow-ups added'], ['done', 'Follow-ups done'], ['logged', 'Calls / messages'], ['overdue', 'Overdue']];
const STATUS_CLASS = { Overdue: 'trc-bad', 'Done late': 'trc-warn', Done: 'trc-ok', 'Due today': 'trc-warn' };

// the side panel: ONE person's report for the chosen days
function PersonPanel({ person, from, to, onClose }) {
  const [fu, setFu] = useState(null);
  const [cands, setCands] = useState(undefined); // undefined = loading, null = not allowed to read
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/followup-report/list', { params: { from, to, personId: person.id, limit: 300 } })
      .then((r) => { if (alive) setFu(r.data); }).catch((e) => { if (alive) setErr(e.response?.data?.error || 'The follow-ups could not be loaded.'); });
    api.get(`/ats/history/recruiter/${person.id}`, { params: { from, to } })
      .then((r) => { if (alive) setCands(r.data); }).catch(() => { if (alive) setCands(null); });
    return () => { alive = false; };
  }, [person.id, from, to]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  // the people this recruiter ADDED in these days (the history rows say the day each was added)
  const added = useMemo(() => {
    if (!cands || !cands.rows) return [];
    return cands.rows.filter((x) => x.added && String(x.added).slice(0, 10) >= from && String(x.added).slice(0, 10) <= to)
      .sort((a, b) => String(b.added).localeCompare(String(a.added)));
  }, [cands, from, to]);

  return (
    <div className="trd-wrap" role="presentation">
      <div className="trd-back" onMouseDown={onClose} aria-hidden="true" />
      <aside className="trd-panel" role="dialog" aria-modal="true" aria-label={`Report of ${person.name}`}>
        <div className="trd-bar">
          <div className="trd-title">
            <b>{person.name}</b>
            <span className="small-muted">{[person.role, person.leadName ? `TL ${person.leadName}` : '', `${fmtDay(from)}${from === to ? '' : ` to ${fmtDay(to)}`}`].filter(Boolean).join(' · ')}</span>
          </div>
          <Link className="btn btn-sm" to={`/ats/history/recruiter/${person.id}`} onClick={onClose}>Complete history</Link>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="trd-body">
          <div className="trd-nums">
            {SHOWN.map(([k, l], i) => <div key={k} className={k === 'overdue' && person.m[i] ? 'trc-bad' : ''}><b>{person.m[i] || 0}</b><span>{l}</span></div>)}
            <div><b>{added.length}</b><span>Candidates added</span></div>
          </div>

          <h4>Candidates added</h4>
          {cands === undefined ? <div className="small-muted">Loading…</div> : cands === null ? <div className="small-muted">This list is not available to you.</div> : (
            <div className="trd-scroll">
              <table className="trc-table">
                <thead><tr><th>Added on</th><th>Candidate</th><th>Requirement</th><th>Now</th></tr></thead>
                <tbody>
                  {added.map((x) => (
                    <tr key={x.applicationId}>
                      <td>{fmtDay(x.added)}</td>
                      <td><Link to={`/candidates/${x.candidateId}`} onClick={onClose}>{x.candidate}</Link></td>
                      <td>{x.requirement}{x.client ? <div className="small-muted">{x.client}</div> : null}</td>
                      <td>{x.outcome ? String(x.outcome).replace(/^./, (c) => c.toUpperCase()) : (x.stageLabel || x.step || '')}</td>
                    </tr>
                  ))}
                  {added.length === 0 && <tr><td colSpan={4} className="small-muted">No candidate was added in these days.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          <h4>Follow-ups and what was written</h4>
          {err && <div className="error-text">{err}</div>}
          {!fu && !err ? <div className="small-muted">Loading…</div> : fu && (
            <div className="trd-scroll">
              <table className="trc-table">
                <thead><tr><th>Date</th><th>Candidate / client</th><th>Requirement</th><th>What happened</th><th>Call back on</th><th>Answer</th><th>Status</th></tr></thead>
                <tbody>
                  {fu.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDay(r.day)}</td>
                      <td>{r.link ? <Link to={r.link} onClick={onClose}>{r.candidateName || r.kind}</Link> : r.candidateName}<div className="small-muted">{r.type}</div></td>
                      <td>{r.requirement || ''}{r.client ? <div className="small-muted">{r.client}</div> : null}</td>
                      <td className="trc-what">{r.what}</td>
                      <td>{r.callBackDay ? fmtDay(r.callBackDay) : ''}</td>
                      <td>{r.outcome || ''}</td>
                      <td><span className={STATUS_CLASS[r.status] || ''}>{r.status}</span></td>
                    </tr>
                  ))}
                  {fu.rows.length === 0 && <tr><td colSpan={7} className="small-muted">No follow-up in these days.</td></tr>}
                </tbody>
              </table>
              {fu.total > fu.rows.length && <div className="small-muted">{`${fu.rows.length} of ${fu.total} follow-ups shown. Narrow the days to see the rest.`}</div>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// the table: one row per person + View. Used inside the TL's card and inside the Super Admin's overall panel.
function ReportTable({ title, onClose }) {
  const [opts, setOpts] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [preset, setPreset] = useState('today');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get('/followup-report/options').then((r) => {
      setOpts(r.data);
      const p = presetsFor(r.data.today)[0];
      setRange({ from: p[2], to: p[3] });
    }).catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!opts || !range.from || !range.to || range.to < range.from) return;
    api.get('/followup-report/summary', { params: { from: range.from, to: range.to, period: 'day', imported: 'include' } })
      .then((r) => { setData(r.data); setFailed(false); }).catch(() => setFailed(true));
  }, [opts, range]);

  if (failed && !data) return onClose ? <div className="error-text">The report could not be loaded.</div> : null; // a login with no report simply has no card
  if (!opts) return onClose ? <div className="small-muted">Loading…</div> : null;
  const idx = data ? SHOWN.map(([k]) => data.fields.indexOf(k)) : [];
  const shown = (r) => ({ ...r, m: idx.map((i) => (i >= 0 ? r.m[i] : 0)) });
  const choose = (key, from, to) => { setPreset(key); setRange({ from, to }); };
  const showLead = !!data && data.table.headers.includes('TL');

  return (
    <>
      <div className="trc-head">
        <h3>{title}</h3>
        <div className="trc-bar">
          {presetsFor(opts.today).map(([k, l, f, t]) => <button key={k} type="button" className={`btn btn-sm${preset === k ? ' btn-primary' : ''}`} onClick={() => choose(k, f, t)}>{l}</button>)}
          <label className="small-muted">From <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); }} /></label>
          <label className="small-muted">To <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); }} /></label>
          {onClose && <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>}
        </div>
      </div>
      {!data ? <div className="small-muted">Loading…</div> : (
        <div className="trd-scroll">
          <table className="trc-table">
            <thead>
              <tr><th>Recruiter</th>{showLead && <th>TL</th>}{SHOWN.map(([k, l]) => <th key={k} className="trc-num">{l}</th>)}<th /></tr>
            </thead>
            <tbody>
              {data.rows.map((raw) => {
                const r = shown(raw);
                return (
                  <tr key={r.id}>
                    <td><b>{r.name}</b>{r.former ? <span className="trc-tag">left</span> : null}</td>
                    {showLead && <td>{r.leadName || ''}</td>}
                    {r.m.map((v, i) => <td key={SHOWN[i][0]} className={`trc-num${v ? '' : ' trc-zero'}${SHOWN[i][0] === 'overdue' && v ? ' trc-bad' : ''}`}>{v || '–'}</td>)}
                    <td className="trc-act"><button type="button" className="btn btn-sm" onClick={() => setOpen(r)}>View</button></td>
                  </tr>
                );
              })}
              {data.rows.length === 0 && <tr><td colSpan={SHOWN.length + 3} className="small-muted">Nobody in this team yet.</td></tr>}
            </tbody>
            {data.rows.length > 1 && (
              <tfoot>
                <tr><td><b>Total</b></td>{showLead && <td />}{idx.map((i, n) => <td key={SHOWN[n][0]} className="trc-num"><b>{(i >= 0 && data.total.m[i]) || '–'}</b></td>)}<td /></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {open && <PersonPanel person={open} from={range.from} to={range.to} onClose={() => setOpen(null)} />}
    </>
  );
}

// the dashboard piece: a team lead gets the card; a Super Admin gets the one "Overall report" button; nobody else gets anything
export default function TeamReportCard({ user }) {
  const [all, setAll] = useState(false);
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') {
    return (
      <div className="trc-adminbar">
        <button type="button" className="btn btn-primary" onClick={() => setAll(true)}>Overall report</button>
        <span className="small-muted">Every recruiter's work: follow-ups, calls and the candidates they added, day by day.</span>
        {all && (
          <div className="trd-wrap" role="presentation">
            <div className="trd-back" onMouseDown={() => setAll(false)} aria-hidden="true" />
            <aside className="trd-panel" role="dialog" aria-modal="true" aria-label="Overall report">
              <div className="trd-body"><ReportTable title="Overall report" onClose={() => setAll(false)} /></div>
            </aside>
          </div>
        )}
      </div>
    );
  }
  if (user.atsRole !== 'TL') return null;
  return <div className="card section trc"><ReportTable title="Report of your team" /></div>;
}
