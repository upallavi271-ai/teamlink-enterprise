import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import EmployeeStatusTag from '../EmployeeStatusTag.jsx';
import { STATUS_GROUPS, ALL_EMPLOYEE_STATUSES, DEFAULT_EMPLOYEE_STATUS, statusGroupOf } from '../../hrStatus';
import '../clients/followUpLog.css';

// THE TEAM'S FOLLOW-UP HISTORY (founder 2026-11-03: "ah history antha respective tls ki kanipinchali"). Reports & Team -> Team
// -> Follow-up history: every follow-up the people of my team wrote, day by day - candidate and client comments, the calls /
// mails logged with "Follow up" and follow-up tasks marked done. A TL sees their own team, the BDE TL the BDEs, Admin and
// Manager everyone, a recruiter only their own (the server decides: GET /client-followlog/team).
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y) return ymd || '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const minus = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const SOURCE = { quick: 'Logged contact', task: 'Follow-up task', manual: 'Comment' };
// RECRUITERS FOLLOW UP CANDIDATES, BDEs FOLLOW UP CLIENTS (founder 2026-11-04: "recruiters followups separate & bde follow up separate"):
// two tabs, each with its own people and its own list. A BDE / BDE TL opens on the client tab, everyone else on the candidate tab.
const SIDES = [
  { key: 'Candidate', side: 'candidate', label: 'Recruiter follow-ups (candidates)', who: 'Recruiters and TLs following up with candidates' },
  { key: 'Client', side: 'client', label: 'BDE follow-ups (clients)', who: 'BDEs following up with clients' },
];

export default function TeamFollowUpHistory() {
  const [range, setRange] = useState({ from: '', to: '' });
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState(''); // 'Candidate' | 'Client' (set from the login when the list first comes)
  const [q, setQ] = useState('');
  // ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the people table and the Person list open with the people who are still here.
  // The follow-up log below always shows every follow-up written in the days chosen, whoever wrote it.
  const [status, setStatus] = useState(DEFAULT_EMPLOYEE_STATUS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/client-followlog/team', { params: { from: range.from || undefined, to: range.to || undefined, personId: personId || undefined } })
      .then((r) => { setData(r.data); setError(''); if (!range.from) setRange({ from: r.data.from, to: r.data.to }); setKind((k) => k || (r.data.viewerSide === 'client' ? 'Client' : 'Candidate')); })
      .catch((e) => setError(e.response?.data?.error || 'The follow-up history could not be loaded.'))
      .finally(() => setLoading(false));
  }, [range.from, range.to, personId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const out = [];
    data.rows
      .filter((r) => (!kind || r.kind === kind) && (!needle || `${r.name} ${r.note} ${r.about || ''} ${r.byName || ''}`.toLowerCase().includes(needle)))
      .forEach((r) => { const last = out[out.length - 1]; if (last && last.day === r.onDate) last.rows.push(r); else out.push({ day: r.onDate, rows: [r] }); });
    return out;
  }, [data, kind, q]);

  const today = data ? data.today : '';
  const quick = (days) => setRange({ from: minus(today, days - 1), to: today });
  const mine = data && data.scope === 'mine';
  const inStatus = (x) => !status || statusGroupOf(x.employmentStatus) === status;
  const side = SIDES.find((t) => t.key === kind) || null;
  // the people of this tab: that side's people, and anyone else who wrote a follow-up of this kind
  const cand = kind === 'Candidate';
  const sideSummaryAll = data ? data.summary.filter((s) => (side ? s.side === side.side : true) || (cand ? s.candidates : s.clients) > 0) : [];
  const sideSummary = sideSummaryAll.filter(inStatus);
  const sidePeople = data ? data.people.filter((p) => (!side || p.side === side.side || sideSummaryAll.some((s) => s.id === p.id)) && inStatus(p)) : [];
  const hiddenLeft = sideSummaryAll.length - sideSummary.length;

  return (
    <div className="card section flog">
      <div>
        <h3 style={{ margin: 0 }}>{mine ? 'My follow-up history' : 'Follow-up history of my team'}</h3>
        <div className="small-muted">
          {mine ? 'Every follow-up you wrote or logged, day by day.' : 'Who followed up with which candidate or client, day by day: comments, logged calls and mails, and follow-up tasks done.'}
        </div>
      </div>

      {/* THE REPORT IN BULK (founder 2026-11-04: "followup report ni bulk lo export cheyyali"): the days, person and search
          chosen above; this tab only, or both tabs in one file (GET /client-followlog/team/export, up to a year). */}
      {data && (
        <div className="flog-filters" style={{ justifyContent: 'flex-end' }}>
          <ExportMenu url="/client-followlog/team/export" label={`Export ${kind === 'Client' ? 'BDE' : 'recruiter'} follow-ups`} params={{ from: range.from, to: range.to, personId, kind, q }} />
          <ExportMenu url="/client-followlog/team/export" label="Export all follow-ups" params={{ from: range.from, to: range.to, personId, q }} />
        </div>
      )}

      <div className="flog-filters" role="tablist" aria-label="Whose follow-ups">
        {SIDES.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={kind === t.key} className={`btn${kind === t.key ? ' btn-primary' : ''}`} onClick={() => { setKind(t.key); setPersonId(''); }}>
            {t.label}{data ? ` · ${data.rows.filter((x) => x.kind === t.key).length}` : ''}
          </button>
        ))}
      </div>
      {side && <div className="small-muted">{side.who}{kind === 'Candidate' ? ': calls, mails and comments on the candidate profile.' : ': comments on the client and requirement pages, and the BDE desk sheet.'}</div>}

      <div className="flog-filters">
        <label className="small-muted">From <input type="date" value={range.from} max={range.to || today} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
        <label className="small-muted">To <input type="date" value={range.to} max={today} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
        {today && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => quick(1)}>Today</button>
            <button type="button" className="btn btn-sm" onClick={() => quick(7)}>7 days</button>
            <button type="button" className="btn btn-sm" onClick={() => quick(30)}>30 days</button>
          </>
        )}
      </div>
      <div className="flog-filters">
        {!mine && data && (
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPersonId(''); }} aria-label="Employee status" title="Employee status: Active = everybody who has not left">
            <option value="">{ALL_EMPLOYEE_STATUSES}</option>
            {STATUS_GROUPS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {!mine && data && (
          <select value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Person">
            <option value="">Everyone in my team</option>
            {sidePeople.map((p) => <option key={p.id} value={p.id}>{`${p.name}${p.role ? ` (${p.role})` : ''}`}</option>)}
          </select>
        )}
        <input type="search" value={q} placeholder="Search a name or what was said…" onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <div className="error-text">{error}</div>}
      {loading && !data && <div className="small-muted">Loading…</div>}

      {data && !mine && (
        <div className="flog-imp-wrap" style={{ maxHeight: 'none' }}>
          <table className="flog-imp-table">
            <thead><tr><th>Person</th><th>{cand ? 'Candidate follow-ups' : 'Client follow-ups'}</th><th>Days with a follow-up</th><th>Last one</th></tr></thead>
            <tbody>
              {sideSummary.map((s) => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setPersonId(personId === s.id ? '' : s.id)} title="Show only this person (click again for everyone)">
                  <td><b>{s.name}</b><EmployeeStatusTag employmentStatus={s.employmentStatus} />{s.role ? <span className="small-muted">{` · ${s.role}`}</span> : null}</td>
                  <td>{cand ? s.candidates : s.clients}</td>
                  <td>{cand ? s.candidateDays : s.clientDays}</td>
                  <td>{(cand ? s.candidateLast : s.clientLast) ? fmtDay(cand ? s.candidateLast : s.clientLast) : <span className="flog-none">None in these days</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenLeft > 0 && status === DEFAULT_EMPLOYEE_STATUS && (
            <div className="small-muted" style={{ padding: '6px 2px' }}>
              Showing the people who are still here. {hiddenLeft} {hiddenLeft === 1 ? 'person who has' : 'people who have'} left {hiddenLeft === 1 ? 'is' : 'are'} not listed: choose <b>Employee status → All</b> (or Exited / Relieved). Their follow-ups, if any, are in the log below.
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="flog-list">
          {groups.map((g) => (
            <div key={g.day} className="flog-day">
              <div className="flog-dayhead">{`${fmtDay(g.day)} · ${g.rows.length}`}</div>
              {g.rows.map((r) => (
                <div key={r.id} className="flog-row">
                  <div className="flog-text"><Link to={r.link}><b>{r.name}</b></Link>{` — ${r.note}`}</div>
                  <div className="flog-meta">
                    <span><b>{r.byName || 'Someone'}</b>{r.byRole ? ` (${r.byRole})` : ''}</span>
                    <span className="flog-req">{r.kind}</span>
                    {r.source !== 'manual' && <span className="flog-tag">{SOURCE[r.source] || r.source}</span>}
                    {r.about && <span className="flog-req">{r.about}</span>}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="small-muted">{cand ? 'No candidate follow-up in these days.' : 'No client follow-up in these days.'}</div>}
        </div>
      )}
    </div>
  );
}
